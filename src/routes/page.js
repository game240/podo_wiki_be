const express = require("express");
const router = express.Router();
const pc = require("../controllers/pageController");

router.post("/page", pc.savePage);
router.get("/page", pc.getPage);

module.exports = router;
