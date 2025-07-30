const express = require("express");
const multer = require("multer");
const router = express.Router();
const upload = multer();
const uc = require("../controllers/uploadController");

router.post("/upload", upload.single("file"), uc.uploadFile);
router.get("/presign", uc.presignUrl);
router.get("/image-proxy", uc.proxyImage);

module.exports = router;
