const fs = require("fs");
require("dotenv").config();
const { MongoClient, ServerApiVersion } = require("mongodb");
var uri = `mongodb+srv://${process.env.MONGODB_CLI_USERNAME}:` +
            `${process.env.MONGODB_CLI_PASSWORD}` +
            "@betterrutgerssoc.emmh2hn.mongodb.net/?retryWrites=true&w=majority";

const apiURL = process.env.API_URL;
const reqRPM = parseInt(process.env.REQUEST_RPM);
const semester = process.env.SEMESTER;

// Returns the subject string, given its level, campus, subject description,
// and subject code.
async function getSubjectStr(C, L, subject) {
    level = (L === "U" || L === "undergraduate") ? "U" : "G";
    campus = C.toUpperCase();
    return (`${level} at ${campus}: ${subject.description} (${subject.code})`);
}

// Sleeps for the given delay.
const sleep = (delay) => new Promise((resolve) => setTimeout(resolve, delay));

// Performs a GET request to the Rutgers SOC API.
async function getSubjectCourses(subject, C, L, fn = {}, log = true) {
    await Promise.resolve(fetch(apiURL + "?" + new URLSearchParams({
        "subject": subject.code,
        "semester": semester,
        "campus": C,
        "level": L
    }))
    .then((response) => response.json())
    .then(async (body) => {
        if (log) {
            const subjectStr = await getSubjectStr(L, C, subject);
            console.log(`${subjectStr} -- Status ${response.status}`);
        }
        await fn(body);
    }));
}

// Create a MongoClient with a MongoClientOptions object to set the Stable API version
const client = new MongoClient(uri, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  }
});

// Link to the MongoDB database.
const db = client.db(`soc_${semester}`);

async function run() {
  try {
    // Connect the client to the server	(optional starting in v4.7)
    await client.connect();
    // Send a ping to confirm a successful connection
    await client.db("admin").command({ ping: 1 });
    console.log("Pinged your deployment. You successfully connected to MongoDB!");
  } finally {
    // Ensures that the client will close when you finish/error
    await client.close();
  }
}
// run().catch(console.dir);

// Makes a directory on the file system or a collection on MongoDB.
function makeDirectory(dest, dirPath, options = {}) {
    if (dest === "FS") fs.mkdirSync(dirPath);
    else if (dest === "MongoDB") {
        const pathArr = dirPath.split("/");
        const name = (pathArr[pathArr.length - 1] === "data-db") ? "" :
            pathArr[pathArr.length - 1];
        if (name === "") return;
        db.collection(name, options);
    }
}
// Reads a JSON file from the local file system or from the MongoDB database.
async function readJSONFrom(dest, path, options = {}) {
    if (dest === "FS") return await JSON.parse(fs.readFileSync(path));
    else if (dest === "MongoDB") {
        // Input dirPath instead of filePath, use options to specify document
        const name = path.split("/")[1];
        return await db.collection(name, options).findOne();
    }
}
// Writes a JSON file to the local file system or to the MongoDB database.
async function writeJSONTo(dest, path, content) {
    if (dest === "FS") fs.writeFileSync(path, JSON.stringify(content, null, 2));
    else if (dest === "MongoDB") {
        const pathArr = path.split("/");
        const name = (pathArr[pathArr.length - 2] === "data-db") ?
            pathArr[pathArr.length - 1].split(".")[0] : pathArr[pathArr.length - 2];
        if (Array.isArray(content)) await db.collection(name).insertMany(content);
        else await db.collection(name).insertOne(content);
    }
}
// Copies a JSON file from one directory in the local file system to
// another directory or MongoDB collection.
async function copyJSON(dest, srcPath, destPath) {
    if (dest === "FS") fs.copyFileSync(srcPath, destPath);
    else if (dest === "MongoDB") {
        const content = await readJSONFrom("FS", srcPath);
        writeJSONTo("MongoDB", destPath, content);
    }
}

module.exports = { api: { url: apiURL, reqRPM: reqRPM, semester: semester,
    getSubjectCourses: getSubjectCourses }, sleep,
    client, db, makeDirectory, readJSONFrom, writeJSONTo, copyJSON };