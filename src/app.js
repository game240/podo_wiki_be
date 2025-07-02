const express = require("express");
const fs = require("fs");
const path = require("path");

const app = express();

const cors = require("cors");
app.use(cors());

// 1) 클라이언트에서 JSON 바디를 받을 수 있도록 설정
app.use(express.json());

// 2) 파일 저장용 디렉토리 (없으면 생성)
const DATA_DIR = path.join(__dirname, "../data");
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

// 3) /api/save 엔드포인트: { filename, content } 수신 후 파일 저장
app.post("/api/save", async (req, res) => {
  try {
    const { filename, content, meta } = req.body;
    if (!filename || !content) {
      return res
        .status(400)
        .json({ message: "filename, content가 필요합니다." });
    }
    const safeName = filename.replace(/[^a-zA-Z0-9_\-\.]/g, "_");
    const filePath = path.join(DATA_DIR, safeName);

    // JSON 형태로 저장 (pretty-print 옵션)
    const toWrite = { meta, content };
    await fs.promises.writeFile(
      filePath,
      JSON.stringify(toWrite, null, 2),
      "utf8"
    );

    res.json({ message: "파일 저장 성공", path: `/data/${safeName}` });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "서버 오류", error: err.message });
  }
});

app.get("/api/page/:filename", async (req, res) => {
  try {
    const safeName = req.params.filename.replace(/[^a-zA-Z0-9_\-\.]/g, "_");
    const filePath = path.join(DATA_DIR, safeName);
    const raw = await fs.promises.readFile(filePath, "utf8");
    const parsed = JSON.parse(raw);
    res.json(parsed); // { meta: {...}, content: { ... } }
  } catch {
    res.status(404).json({ message: "파일을 찾을 수 없습니다." });
  }
});

const multer = require("multer");
const supabase = require("./supabaseClient");

const upload = multer(); // 메모리 상에서 파일 처리

app.post("/api/upload", upload.single("file"), async (req, res) => {
  try {
    const file = req.file;
    if (!file) return res.status(400).json({ message: "파일이 필요합니다." });

    // 1) private 폴더로 업로드
    const filePath = `private/wiki-images/${Date.now()}_${file.originalname}`;
    const { data: uploadData, error: uploadErr } = await supabase.storage
      .from("podo-wiki")
      .upload(filePath, file.buffer, {
        cacheControl: "3600",
        upsert: false,
      });
    if (uploadErr) throw uploadErr;

    // 2) 업로드된 경로로 서명된 URL 생성 (5분 유효)
    const { data: signData, error: signErr } = await supabase.storage
      .from("podo-wiki")
      .createSignedUrl(uploadData.path, 300);
    if (signErr) throw signErr;

    // 3) 결과 반환
    res.json({
      path: uploadData.path, // 서버에 저장된 실제 경로
      signedUrl: signData.signedUrl, // TipTap에 바로 넣을 URL
    });
  } catch (err) {
    console.error("Upload Error:", err);
    res
      .status(500)
      .json({ message: "업로드 중 오류 발생", error: err.message });
  }
});

// presignedURL only API
app.get("/api/presign", async (req, res) => {
  try {
    const filePath = Array.isArray(req.query.path)
      ? req.query.path[0]
      : req.query.path;

    if (!filePath) {
      return res
        .status(400)
        .json({ message: "path 쿼리 파라미터가 필요합니다." });
    }

    const { data: signData, error: signErr } = await supabase.storage
      .from("podo-wiki")
      .createSignedUrl(filePath, 300);

    if (signErr) {
      console.error("Presign Error:", signErr);
      throw signErr;
    }

    res.json({ signedUrl: signData.signedUrl });
  } catch (err) {
    console.error("GET /api/presign Error:", err);
    res
      .status(500)
      .json({ message: "Signed URL 생성 중 오류 발생", error: err.message });
  }
});

app.get("/api/image-proxy", async (req, res) => {
  try {
    const filePath = Array.isArray(req.query.path)
      ? req.query.path[0]
      : req.query.path;
    if (!filePath) {
      return res
        .status(400)
        .json({ message: "path 쿼리 파라미터가 필요합니다." });
    }

    // Supabase에서 짧은 유효기간된 URL 생성(예: 5분)
    const { data: signData, error: signErr } = await supabase.storage
      .from("podo-wiki")
      .createSignedUrl(filePath, 300);
    if (signErr) throw signErr;

    // 리다이렉트: 클라이언트 <img> 태그에서 바로 presigned URL로 전환
    res.redirect(signData.signedUrl);
  } catch (err) {
    console.error("GET /api/image-proxy Error:", err);
    res
      .status(500)
      .json({ message: "Signed URL 생성 중 오류 발생", error: err.message });
  }
});

// 4) 서버 시작
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ Server running on http://localhost:${PORT}`);
});
