const express = require("express");
const router = express.Router();
const pc = require("../controllers/pageController");

router.post("/page", pc.savePage);
router.get("/page", pc.getPage);
router.get("/revision/:revision_id", pc.getRevisionById);

module.exports = router;
