// Fetches each courses###.json file from the Rutgers SOC API, given the apiUrl.
// Then, finalizes the data, which can be stored either locally or on MongoDB.

const fs = require("fs");
const db = require("./syncdb");

// Fetches all subjects from a level, with a delay (to limit number of API
// accesses per minute). Then rewrites the code.json "subjects" field.
const delay = Math.floor(60/db.api.reqRPM * 1000);
const sleep = (delay) => new Promise((resolve) => setTimeout(resolve, delay));

async function forAllSubjects(doThis, thenThis = () => {}) {
    // Obtain the JSON from codes.json.
    const subjects = db.readJSONFrom("FS", "./data/codes.json").subjects;

    // Iterate through the subjects.
    await subjects
    .forEach(async (subject, index) => {setTimeout(async () => {["U", "G"]
        .forEach(async (L, index) => {setTimeout(async() => {["NB", "NK", "CM"]
            .forEach(async (C, index) => {setTimeout(async() => {
                await db.api.getSubjectCourses(subject, C, L, (body) => {
                    doThis(subject, C, L, body);
                });
            }, delay * index); });
        }, delay * index * 3); });
    }, delay * index * 6); });

    await sleep(delay * (Object.keys(subjects).length * 6));
    thenThis();
}



// OBJECTIVE: Write the undergraduate and graduate folders, which each contain
// respective nb (New Brunswick), nk (Newark), and cm (Camden) folders with courses
// JSON files structured as courses###.json, where ### is the subject code.

// Creates the directories.
async function makeDirs() {
    ["undergraduate", "graduate"].forEach((level) => {
        fs.mkdirSync(__dirname + `/data/${level}`);
        ["nb", "nk", "cm"].forEach((campus) => {
            fs.mkdirSync(__dirname + `/data/${level}/${campus}`);
        });
    });
}

// Writes courses###.json files for each directory.
async function populateDirsWithCourses() {
    var allSubjects = {};
    await forAllSubjects((subject, C, L, body) => {
        if ((JSON.stringify(body) === "[]")) {
            console.log("\tNo courses found.");
            return;
        };
        var level = (L === "U") ? "undergraduate" : "graduate", campus = C.toLowerCase();
        var dirPath = __dirname + `/data/${level}/${campus}`;
        // Create a new object on first iteration.
        if (allSubjects[dirPath] == null) allSubjects[dirPath] = {};
        allSubjects[dirPath][`${subject.code}`] = subject.description;
        // Write courses###.json file, given body.
        db.writeJSONTo("FS", `${dirPath}/courses${subject.code}.json`, body);
        console.log(`\tcourses${subject.code}.json was written.`);
    });
}

// Writes a subjects.json file for each directory.
async function populateDirsWithSubject() {
    var allSubjects = db.readJSONFrom("FS", "./data/codes.json").subjects;
    ["undergraduate", "graduate"].forEach(async (level) => {
        ["nb", "nk", "cm"].forEach(async (campus) => {
            // Build the subjects object.
            var subjects = {};
            var dirPath = __dirname + `/data/${level}/${campus}`;
            fs.readdir(dirPath, (err, files) => {files.forEach(async (file) => {
                if (file.substring(0, 7) !== "courses") return;
                var code = file.substring(7, 10);
                var description = await allSubjects.find(e => {return e.code === code}).description;
                subjects[code] = description;
            }); });
            await sleep(2000); // give some time for the above code to finish executing

            // Sort the subject codes in ascending order.
            Object.keys(subjects).sort().reduce(
                (obj, key) => { obj[key] = subjects[key]; return obj; },
            {});
            db.writeJSONTo("FS", `${dirPath}/subjects.json`, subjects);
        });
    });
}

// Accesses courses properties from all courses###.json files.
async function getCoursesProperties(fnCampuses, fnSubjects, fnCourses, fnSections) {
    ["undergraduate", "graduate"].forEach(async (level) => {
        ["nb", "nk", "cm"].forEach(async (campus) => {
            var dirPath = __dirname + `/data/${level}/${campus}`;
            fnCampuses(dirPath);
            fs.readdir(dirPath, (_err, files) => {files.forEach(async (fileName) => {
                if (fileName.substring(0, 7) !== "courses") return;
                var courses = await db.readJSONFrom("FS", `${dirPath}/${fileName}`);
                await sleep(100);
                await courses.forEach((course) => {
                    course.sections.forEach((section) => {
                        fnSections(section);
                    });
                    fnCourses(course);
                });
                await sleep(100); // give some time for the above code to finish executing
                fnSubjects(dirPath, fileName, courses);
            }); });
        });
    });
}

// Logs given properties for all courses###.json files.
async function logCoursesProperties(courseProperties, sectionProperties = []) {
    var numCourseProperties = new Array(courseProperties.length).fill(0);
    var numSectionProperties = new Array(sectionProperties.length).fill(0);
    await getCoursesProperties(() => {}, () => {}, async (course) => {
        courseProperties.forEach(async (property, index) => {
            if (course[property] === undefined) { numCourseProperties[index] = -1; return; }
            if (course[property] === null || course[property].length === 0) return;
            numCourseProperties[index] ++;
        });
    }, async (section) => {
        sectionProperties.forEach(async (property, index) => {
            if (section[property] === undefined) { numSectionProperties[index] = -1; return; }
            if (section[property] === null || section[property].length === 0) return;
            numSectionProperties[index] ++;
        });
    });
    await sleep(10 * (numCourseProperties.length + numSectionProperties.length));
    console.log("\nCOURSE PROPERTIES:");
    courseProperties.forEach((property, index) => {
        console.log(`${numCourseProperties[index]} instances of "${property}" found.`);
    });
    console.log("\nSECTION PROPERTIES:")
    sectionProperties.forEach((property, index) => {
        console.log(`${numSectionProperties[index]} instances of "${property}" found.`);
    });
}

// Creates the data-db directory and populates it with the finalized data.
async function finalizeDataTo(dest) {
    if (dest === "FS" && !fs.existsSync("./data")) {
        console.log("Unzip 'original-data.zip' first to create the 'data' folder.");
        return;
    } else if (dest === "MongoDB") console.log("Check MongoDB, then manually terminate " +
        "this function using '^C' when each collection has successfully been populated.");
    
    var subjects = {}, sections = [];
    var allSubjects = {}, campusSubjects;
    getCoursesProperties(async (dirPath) => { // fnCampuses
        allSubjects[dirPath] = [];
    },
    async (dirPath, fileName, courses) => { // fnSubjects
        // Initialization
        subjects = await db.readJSONFrom("FS", `${dirPath}/subjects.json`);
        campusSubjects = allSubjects[dirPath];
        // Rewrite courses###.json file:
        var newCourses = {};
        var code = fileName.substring(7, 10);
        newCourses.description = subjects[code];
        newCourses.code = code;
        courses.forEach((course) => {
            newCourses["course_" + course.courseNumber] = course;
            delete newCourses["course_" + course.courseNumber].courseNumber;
        });
        campusSubjects.push(newCourses);
    },
    async (course) => { // fnCourses
        // Delete Course Properties:
        var courseProperties = ["campusCode", "openSections", "subjectGroupNotes",
        "offeringUnitTitle", "courseDescription"];
        courseProperties.forEach((property) => { delete course[property]; });
        // Rewrite Course Sections:
        var sectionsArr = new Array(course.sections.length).fill("");
        course.sections.forEach((section, i) => { sectionsArr[i] = section.index; });
        course.sections = sectionsArr;
        // Rewrite Course Core Codes:
        var coreCodesArr = new Array(course.coreCodes.length).fill("");
        course.coreCodes.forEach((coreCode, i) => {
            coreCodesArr[i] = coreCode.coreCode;
        });
        course.coreCodes = coreCodesArr;
    },
    async (section) => { // fnSections
        // Delete Section Properties:
        var sectionProperties = ["openStatus", "sessionDates", "subtopic", "legendKey"];
        sectionProperties.forEach((property) => { delete section[property]; });
        // Delete Section Meeting Times Properties:
        var meetingTimesProperties = ["campusLocation", "campusAbbrev", "meetingModeCode"];
        section.meetingTimes.forEach((time) => { meetingTimesProperties.forEach((property) => {
            delete time[property];
        })});
        // Write to sections.json file:
        sections.push(section);
    });
    await sleep(2000); // give some time for the above code to finish executing

    // Create new db-data folder.
    db.makeDirectory(dest, __dirname + "/data-db");
    ["undergraduate", "graduate"].forEach((level) => {
        ["nb", "nk", "cm"].forEach(async (campus) => {
            var dirPath = __dirname + `/data-db/${level}-${campus}`;
            db.makeDirectory(dest, dirPath);
            db.writeJSONTo(dest, `${dirPath}/subjects.json`,
                allSubjects[__dirname + `/data/${level}/${campus}`]);
        });
    });
    db.writeJSONTo(dest, `./data-db/sections.json`, sections);
    db.copyJSON(dest, "./data/codes.json", "./data-db/codes.json");
}

// Run the following functions in order, one at a time.
// makeDirs();
// populateDirsWithCourses();
// populateDirsWithSubject();
// finalizeDataTo("FS");
// finalizeDataTo("MongoDB");

// logCoursesProperties(["subjectNotes", "courseNumber", "subject", "campusCode",
//     "synopsisUrl", "subjectGroupNotes", "offeringUnitCode", "offeringUnitTitle",
//     "title", "courseDescription", "preReqNotes", "sections", "supplementCode",
//     "credits", "unitNotes", "coreCodes", "courseNotes", "expandedTitle"], [
//     "sectionEligibility", "sessionDatePrintIndicator", "examCode",
//     "specialPermissionAddCode", "crossListedSections", "sectionNotes",
//     "specialPermissionDropCode", "instructors", "number", "majors",
//     "sessionDates", "specialPermissionDropCodeDescription", "subtopic",
//     "comments", "minors", "campusCode", "index", "unitMajors", "printed",
//     "specialPermissionAddCodeDescription", "subtitle", "legendKey",
//     "honorPrograms"]);