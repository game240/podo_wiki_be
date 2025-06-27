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

// 4) 서버 시작
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ Server running on http://localhost:${PORT}`);
});
