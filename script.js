const fs = require("fs");
const path = require("path");

const getScript = (fileName) => {
    try {
        const filePath = path.join(__dirname, "scripts", fileName);
        return fs.readFileSync(filePath, "utf8").trim();
    } catch (e) {
        console.error("[SCRIPTS ERROR] Failed to load " + fileName + ": " + e.message);
        return "-- Script " + fileName + " missing on server";
    }
};

module.exports = {
    main: getScript("main.lua"),
    mobile: getScript("mobile.lua")
};
