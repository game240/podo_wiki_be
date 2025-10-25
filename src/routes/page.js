const express = require("express");
const router = express.Router();
const pc = require("../controllers/pageController");

router.post("/page", pc.savePage);
router.get("/page", pc.getPage);
router.get("/revision/:revision_id", pc.getRevisionById);
router.get("/revision/revision_number", pc.getRevisionByNumber);
router.get("/revision/current_rev_number", pc.getCurrentRevNumber);

module.exports = router;
