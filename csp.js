// Performs the functions of the Rutgers Course Schedule Planner, which
// generates a list of possible schedules given a list of courses. Implements
// a points system whereby generated schedules are ranked based on how many
// points they attain.

const db = require("./syncdb");
const soc = db.db;

// WEBREG RULES
const travelRules = {
    minTravelTime: 20,
    minTravelTimeBetweenCampuses: 40,
    minTravelTimeExceptions:
        [{ campus1: "COLLEGE AVENUE", campus2: "DOWNTOWN NB", minTime: 20},
         { campus1: "BUSCH", campus2: "LIVINGSTON", minTime: 20}]
}
// CHANGE BELOW AFTER DOING MORE RESEARCH. FOR UNDERGRADUATE NB, LINK IS BELOW:
// https://nbregistrar.rutgers.edu/undergrad/s22prereg.htm
const creditRules = {
    minCredits: 12,
    maxCredits: 18
}

// Parses course IDs of the form UNIT:SUBJECT:COURSE.
// E.g., 01:198:111, 04:189:101, 01:640:251
// NOTE: unitCode is discarded; it is irrelevant.
function parseCourseCodes(courseIDs) {
    var parsedCourseCodes = [];
    courseIDs.forEach((id) => { // code: e.g., 01:198:111
        var idArr = id.split(":"); // ':' is the delimiter
        parsedCourseCodes.push({
            id: id, // original id
            subjectCode: idArr[idArr.length - 2],
            courseCode: idArr[idArr.length - 1]
        });
    });
    return parsedCourseCodes;
}

/**
 * Adds a list of meetingTime objects as a property of the given section.
 * @param {object} section the section
 * @returns the section's meeting times as an Array of meetingTimes objects
 */
function addMeetingTimes(section) {
    var meetingTimes = [];
    const getNumericalTime = (time, pmCode, day) => {
        const dayAddend = { "M": 0, "T": 1, "W": 2, "TH": 3, "F": 4, "S": 5 };
        const pmCodeAddend = { "A": 0, "P": 12 };
        const hours = parseInt(time.substring(0, 2)) % 12;
        const minutes = parseInt(time.substring(2, 4));
        return dayAddend[day]*60*24 + (pmCodeAddend[pmCode] + hours)*60 + minutes;
    };
    for (var time of section.meetingTimes) {
        // If startTime or endTime are null, no meetingTime; online/asynchronous classes
        if (time.startTime === null || time.endTime === null) continue;
        var meetingTime = {
            startTime: getNumericalTime(time.startTime, time.pmCode, time.meetingDay),
            endTime: getNumericalTime(time.endTime, time.pmCode, time.meetingDay),
            location: { campusName: time.campusName, buildingCode: time.buildingCode,
                        roomNumber: time.roomNumber },
            mode: { baClassHours: time.baClassHours, description: time.meetingModeDesc }
        }
        if (meetingTime.endTime - meetingTime.startTime < 0) // switch from AM to PM
            meetingTime.endTime = getNumericalTime(time.endTime, "P", time.meetingDay);
        meetingTimes.push(meetingTime);
    }
    meetingTimes.sort((a, b) => { return a.startTime - b.startTime; });
    delete section.meetingTimes;
    section.meetingTimes = meetingTimes;
    // If ALL online/asynchronous classes ...
    if (meetingTimes.length === 0) section.earliestMeetingTime = 10080;
    else section.earliestMeetingTime = meetingTimes[0].startTime;
}

/**
 * Returns the openStatus for each section corresponding to the given courseID.
 * @param courseID the courseID of the course
 * @returns a parallel array of openStatuses corresponding to each section of
 * the course
 */
async function getSectionsOpenStatuses(level, campus, courseID) {
    const [parsedCourseCode] = parseCourseCodes([courseID]);
    const subject = {
        description: `subject_${parsedCourseCode.subjectCode}`,
        code: parsedCourseCode.subjectCode
    };
    const C = campus.toUpperCase();
    const L = (level === "U" || level === "undergraduate") ? "U" : "G";
    var openStatuses = [];
    await db.api.getSubjectCourses(subject, C, L, async (body) => {
        const apiCourse = body.find((course) =>
            course.courseNumber === parsedCourseCode.courseCode);
        openStatuses = await Promise.all(apiCourse.sections.map(async (section) => {
            return section.openStatus;
        }));
    }, false);
    return openStatuses;
}

/**
 * Returns percentInMeetingTimesRanges of the section.
 * @param {object} section the section
 * @param {object[]} meetingTimesRanges the meetingTimesRanges object; e.g.,
 * meetingTimesRanges = [ { startTime:  600, endTime: 1000 },
 *                        { startTime: 2160, endTime: 3000 }, ...]
 * @retursn the percentInMeetingTimesRanges value
 */
function getPercentInMeetingTimesRanges(section, meetingTimesRanges) {
    if (section.meetingTimes.length === 0) { // online/asynchronous class
        return 1; // no meetingTimes
    }
    var totalTime = 0, matchTime = 0;
    for (const meetingTime of section.meetingTimes) {
        for (const meetingTimesRange of meetingTimesRanges) {
            // Measure the overlap of meetingTime and meetingTimesRange.
            const overlap = Math.min(meetingTime.endTime, meetingTimesRange.endTime) -
                Math.max(meetingTime.startTime, meetingTimesRange.startTime);
            matchTime += (overlap > 0) ? overlap : 0;
        }
        totalTime += (meetingTime.endTime - meetingTime.startTime);
    }
    return matchTime / totalTime;
}

/**
 * Checks if there is a match between the section property corresponding to
 * the option and the requirement.
 * @param property the section property
 * @param requirement the requirement
 * @returns true if there is a match, false otherwise
 */
function checkMatch(property, requirement) {
    // CONTAINS: instructors
    if (typeof requirement === "object" && !Array.isArray(requirement)) {
        // Check if requirement is CONTAINED WITHIN the property.
        for (const obj of property) {
            if (JSON.stringify(Object.values(obj)) ===
                JSON.stringify(Object.values(requirement))) return true;
        }
        return false;
    }
    // IN: number, printed, openStatus, inMeetingTimesRanges
    if (typeof requirement === "object" && Array.isArray(requirement)) {
        // Check if property is CONTAINED WITHIN the requirement.
        if (requirement.includes(property)) return true;
        return false;
    }
    // MATCH: number, printed, openStatus, inMeetingTimesRanges
    if (typeof requirement !== "object") {
        // Check if property === requirement.
        if (requirement === property) return true;
        return false;
    }
}

/**
 * Returns a list of courses and a list of their corresponding sections, given
 * options to select specific sections.
 * @param {string} level the level, either "undergraduate" or "graduate"
 * @param {string} campus the campus, either "nb" (New Brunswick) "nk" (Newark), or
 * "cm" (Camden)
 * @param {string[]} courseIDs An Array of course IDs of the form
 *     UNIT:SUBJECT:COURSE; e.g., 01:198:111, 04:189:101, 01:640:251.
 * @returns a list of lists of sections corresponding to each courseID
 */
async function getSectionsOfCourses(level, campus, courseIDs, options = {}) {
    const courseCodes = parseCourseCodes(courseIDs);
    const sectionsOfCourses = await Promise.all(courseCodes.map(async (parsedCode) => {
        let [subjectCode, courseCode, courseID] =
            [parsedCode.subjectCode, parsedCode.courseCode, parsedCode.id];
        // Get the subject and then the course.
        const subject = await soc.collection(`${level}-${campus}`)
            .findOne({ code: subjectCode });
        if (subject === null)
            throw new Error(`${courseID} in ${level}-${campus} has an invalid subject code.`)
        const course = subject[`course_${courseCode}`];
        if (course === undefined)
            throw new Error(`${courseID} in ${level}-${campus} is an invalid course.`);
        
        // Get the sections that match the query strings specified in options.
        const sectionOptions = { ...options.ALL, ...options[courseID] };
        const openStatuses = (sectionOptions.openStatus !== undefined) ?
            await getSectionsOpenStatuses(level, campus, courseID) : null;
        var sections = await Promise.all(course.sections.map(async (index, i) => {
            var section = await soc.collection("sections").findOne({ index: index });
            addMeetingTimes(section);
            // Assign points to each section. Points will be dependent on the following:
            // - percentInMeetingTimesRanges
            // - instructorsRatings (to be implemented later)
            section.points = 0; // assign points to sections
            // Consider unlisted openStatus and inMeetingTimesRanges options.
            if (sectionOptions.openStatus !== undefined)
                section.openStatus = openStatuses[i];
            if (sectionOptions.meetingTimesRanges !== undefined) {
                section.points += getPercentInMeetingTimesRanges(section,
                    sectionOptions.meetingTimesRanges);
            }
            
            // Check the number of requirements met and the total number of requirements.
            section = { ...section, requirementsMet: {}, numRequirements: 0 };
            for (const [option, requirement] of Object.entries(sectionOptions)) {
                if (option === "meetingTimesRanges") continue; // not a real requirement
                var match = checkMatch(section[option], requirement);
                if (match) section.requirementsMet[option] = requirement;
                section.numRequirements ++;
            }
            return section;
        }));
        // Sort the sections based on requirementsMet and then by points.
        const getPercentRequirementsMet = (section) => {
            return (Object.entries(section.requirementsMet).length / section.numRequirements);
        };
        sections.sort((a, b) => {
            if (getPercentRequirementsMet(a) === getPercentRequirementsMet(b))
                return (b.points - a.points);
            return (getPercentRequirementsMet(b) - getPercentRequirementsMet(a));
        });
        return sections;
    }));
    db.client.close();
    return sectionsOfCourses;
}

/**
 * Returns true if the travelTime object is valid, false otherwise, or null if
 * the travelTime object is irrelevant
 * @param {object} travelTime the travelTime object
 * @param {object} rules the travelRules object containing rules that validate
 * the travelTime
 * @returns true if the travelTime is valid, false otherwise
 */
function isValidTravelTime(travelTime, rules) {
    let [a, b, t] = [travelTime.fromCampusName, travelTime.toCampusName, travelTime.time];
    let [mTT, mTTBC] = [rules.minTravelTime, rules.minTravelTimeBetweenCampuses];
    if (t < 0) return false; // there is an overlap; travelTime is invalid
    if (a === b) return ((t < mTT) ? false : true); // within the same campus
    // Check exceptions to the rules.
    for (var exception of rules.minTravelTimeExceptions) {
        if (((a === exception.campus1) && (b === exception.campus2)) ||
            ((b === exception.campus1) && (a === exception.campus2))) {
            return ((t < exception.minTime) ? false : true);
        }
    }
    return ((t < mTTBC) ? false : true); // between two different campuses
}

/**
 * Returns a list of travelTime objects between the given section objects,
 * structured as follows:
 * { fromCampusName: "COLLEGE AVENUE", toCampusName: "BUSCH", time: 30 }
 * If there is an overlap or if at least one of the rules is broken, no valid
 * schedule is produced, and returns null.
 * @param {object[]} sections the sections, as objects
 * @param {object} rules the rules used to validate each travelTime object
 * @returns the travel times between the section meeting times as travelTime
 * objects, or null if at least one travelTime object is invalid
 */
function getTravelTimes(sections, rules = travelRules) {
    var allMeetingTimes = [], travelTimes = [];
    // Get the sorted allMeetingTimes.
    for (var section of sections) {
        const meetingTimes = section.meetingTimes;
        allMeetingTimes = allMeetingTimes.concat(meetingTimes);
    }
    allMeetingTimes.sort((a, b) => { return a.startTime - b.startTime; });

    // Get the travelTimes between each meetingTimes.
    for (var i = 0; i < allMeetingTimes.length - 1; i ++) {
        const times1 = allMeetingTimes[i], times2 = allMeetingTimes[i + 1];
        var travelTime = {
            fromCampusName: times1.location.campusName,
            toCampusName: times2.location.campusName,
            time: (times1.endTime === null || times2.startTime === null) ?
                null : (times2.startTime - times1.endTime)
        }
        // Check if any rules are broken.
        var isValid = isValidTravelTime(travelTime, rules);
        if (isValid === false) return null; // bad travelTime object
        if (isValid === null) continue; // irrelevant travelTime object
        travelTimes.push(travelTime);
    }
    return travelTimes;
}

/**
 * Returns a string that displays important data for the section.
 * @param courseID the courseID of the course
 * @param section the section
 * @returns a one-line string that displays the data
 */
function getSectionStr(courseID, section) {
    // Convert a numerical time into a time string.
    const getDayAndTime = (time) => {
        const dayMap = { "0": "MON", "1": "TUE", "2": "WED", "3": "THU",
            "4": "FRI", "5": "SAT" };
        const pmMap = { "0": "AM", "1": "PM" };
        var day, hours, mins, pm;
        day = dayMap[Math.floor(time / 1440).toString()];
        time = time % 1440;
        hours = Math.floor(time / 60);
        pm = pmMap[Math.floor(hours / 12).toString()];
        hours = (hours % 12 < 10) ? ` ${hours % 12}` : `${hours % 12}`;
        mins = (time % 60 < 10) ? `0${time % 60}` : `${time % 60}`;
        return [day, `${hours}:${mins} ${pm}`];
    }
    var str = `section: ${courseID}:${section.number},    index: ${section.index}    -->`;
    const meetingTimes = section.meetingTimes;
    for (var meetingTime of meetingTimes) {
        if (meetingTime.startTime === null || meetingTime.endTime === null) {
            str += `    Online/Asynchronous Content`
        }
        else {
            var day, startTime, endTime;
            [day, startTime] = getDayAndTime(meetingTime.startTime);
            [day, endTime] = getDayAndTime(meetingTime.endTime);
            str += `    ${day}, ${startTime} to ${endTime}`;
        }
    }
    return str;
}

/**
 * Returns a schedule object given parallel arrays of courseIDs and sections.
 * @param {string[]} courseIDs the courseIDs used to write the schedule
 * @param {object[]} sections the sections corresponding to each courseID
 * @param {boolean} fullForm true to output object[], false to output string[]
 * @returns the schedule, either as an object[] or as a string[]
 */
function getSchedule(courseIDs, sections, fullForm = false) {
    // Create an indices array which will be mapped to the sections array.
    var indices = sections.map((_x, i) => i); // indices === [0, 1, 2, ...]
    indices.sort((a, b) => {
        return (sections[a].earliestMeetingTime - sections[b].earliestMeetingTime);
    });
    // Now sort both sections and courseIDs by mapping them to indices.
    sections = indices.map(x => sections[x]);
    courseIDs = indices.map(x => courseIDs[x]);
    // Build the schedule object.
    const schedule = {
        list: [],
        points: 0,
        percentRequirementsMet: 0,
        requirementsMet: {}
    };
    var numRequirementsMet = 0, totalNumRequirements = 0;
    var totalPoints = 0; // travelTimesPoints TO BE IMPLEMENTED
    for (var i = 0; i < courseIDs.length; i ++) {
        if (fullForm) schedule.list.push(sections[i]);
        else schedule.list.push(getSectionStr(courseIDs[i], sections[i]));
        numRequirementsMet += Object.entries(sections[i].requirementsMet).length;
        totalNumRequirements += sections[i].numRequirements;
        schedule.requirementsMet[courseIDs[i]] = sections[i].requirementsMet;
        totalPoints += sections[i].points;
    }
    schedule.percentRequirementsMet = numRequirementsMet / totalNumRequirements;
    schedule.points = totalPoints / courseIDs.length;
    return schedule;
}

/**
 * Recursive function that generates a list of possible schedules.
 * @param {string[]} courseIDs the courseIDs used to write the schedule
 * @param {object[]} sectionsOfCourses the list of lists of sections
 * corresponding to each courseID
 * @param {int[]} pointers the array of indices for each list of sections
 * corresponding to each courseID
 * @param {int[]} finalPointers the pointers array returned at the end of
 * method execution for the given batchSize of schedules
 * @param {object[]} schedules the list to push generated schedules into
 * @param {object} options the options for outputting schedules
 * @returns the finalPointers array
 */
function pushSchedules(courseIDs, sectionsOfCourses, pointers, schedules, options) {
    // Create while loop to traverse sections corresponding to the last pointer.
    while (pointers[pointers.length - 1] < sectionsOfCourses[pointers.length - 1].length) {
        // Get the sections according to the pointers array.
        var sections = [];
        for (var i = 0; i < pointers.length; i ++) {
            sections.push(sectionsOfCourses[i][pointers[i]]);
        }
        var travelTimes = getTravelTimes(sections);

        // Success! travelTimes is not null ...
        if (travelTimes !== null) {
            // Success: Go one level deeper, if (pointers.length < courseIDs.length).
            if (pointers.length < courseIDs.length) {
                var newPointers = [...pointers, 0];
                pushSchedules(courseIDs, sectionsOfCourses, newPointers, schedules, options);
            }
            // Final Success: If (pointers.length === courseIDs.length), sections from
            // all courses have been validated! Push a schedule to schedules.
            else if (pointers.length === courseIDs.length) {
                const schedule = getSchedule(courseIDs, sections, options.fullForm);
                schedules.push(schedule);
            }
        }

        // Backtrack: Increment the last pointer.
        pointers[pointers.length - 1] ++;
        if (schedules.length > options.batchSize - 1) return;
    }
}

/**
 * Generates a list of possible schedules given a list of courses and options.
 * @param {string} level the level, either "undergraduate" or "graduate"
 * @param {string} campus the campus, either "nb" (New Brunswick) "nk" (Newark), or
 * "cm" (Camden)
 * @param {string[]} courseIDs An Array of course IDs of the form
 *     UNIT:SUBJECT:COURSE; e.g., 01:198:111, 04:189:101, 01:640:251.
 * @param options special preferences corresponding to the courseIDs
 * @returns a list of possible schedules
 */
async function generateSchedules(level, campus, courseIDs, courseOptions = {},
    options = {}) {
    options = { fullForm: false, byPoints: false, batchSize: 500, ...options };
    // Obtain the parallel array of section lists sectionsOfCourses.
    const sectionsOfCourses = await getSectionsOfCourses(level, campus, courseIDs, courseOptions);
    // Checks if any courses have no valid sections and prints them to the console.
    var noValidSections = false;
    sectionsOfCourses.forEach((course, index) => {
        if (course.length === 0) {
            console.log(`${courseIDs[index]} has no valid sections.`);
            noValidSections = true;
        }
    });
    if (noValidSections) return [];

    var schedules = []; // list of possible schedules
    // Push schedules to the schedules array using a recursive algorithm.
    pushSchedules(courseIDs, sectionsOfCourses, [0], schedules,
        { fullForm: options.fullForm, batchSize: options.batchSize });
    // Sort the schedules, first by percentRequirementsMet, then by points.
    const properties = (options.byPoints) ? ["points", "percentRequirementsMet"] :
        ["percentRequirementsMet", "points"];
    schedules.sort((a, b) => {
        if (a[properties[0]] === b[properties[0]])
            return b[properties[1]] - a[properties[1]];
        return b[properties[0]] - a[properties[0]];
    });
    // Write the generated schedules JSON file.
    await db.writeJSONTo("FS", "./schedules/schedules.json", schedules);
    return schedules;
}

(async () => {
    const start = Date.now();

    const courseIDs = ["01:640:477", "01:640:252", "01:090:125",
        "01:198:211", "01:090:103"];
    // const courseIDs = ["01:160:162", "01:750:204", "01:160:171", "01:750:206",
    //     "01:090:125", "07:965:211", "07:965:231"];

    const meetingTimesRanges = [
        { startTime:  629, endTime:  967 },
        { startTime: 2069, endTime: 2407 },
        { startTime: 3509, endTime: 3847 },
        { startTime: 4949, endTime: 5287 },
        { startTime: 6389, endTime: 6727 }
    ];
    
    const courseOptions = {
        "ALL": { printed: "Y", openStatus: true, meetingTimesRanges: meetingTimesRanges },
        "01:198:211": { instructors: { name: "KANIA, JAY" } }
    };

    const schedules = await generateSchedules("undergraduate", "nb", courseIDs, courseOptions,
        { batchSize: 20 });

    const numMatchingSchedules = schedules.filter((a) => a.percentRequirementsMet === 1).length;
    console.log(`${schedules.length} schedules generated. ${numMatchingSchedules} match.`);
    const end = Date.now();
    console.log(`\nExecution time: ${end - start} ms`);
})();

module.exports = { generateSchedules };