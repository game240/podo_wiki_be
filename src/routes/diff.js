const express = require("express");
const router = express.Router();
const dc = require("../controllers/diffController");

router.get("/diff", dc.getDiff);

module.exports = router;
