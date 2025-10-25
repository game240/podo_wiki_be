const express = require("express");
const router = express.Router();
const rc = require("../controllers/recentController");

router.get("/recent-change", rc.listChanges);
router.get("/recent-change/pages", rc.listPages);

module.exports = router;
