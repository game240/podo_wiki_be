const express = require("express");
const router = express.Router();
const sc = require("../controllers/searchController");

router.get("/search", sc.searchPages);
router.get("/search-autocomplete", sc.autocomplete);

module.exports = router;
