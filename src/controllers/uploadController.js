const supabase = require("../config/supabaseClient");

exports.uploadFile = async (req, res) => {
  try {
    const file = req.file;
    if (!file) {
      return res.status(400).json({ message: "파일이 필요합니다." });
    }

    // 1) private 폴더로 업로드
    const filePath = `private/wiki-images/${Date.now()}_${file.originalname}`;
    const { data: uploadData, error: uploadErr } = await supabase.storage
      .from("podo-wiki")
      .upload(filePath, file.buffer, {
        cacheControl: "3600",
        upsert: false,
      });
    if (uploadErr) {
      throw uploadErr;
    }

    // 2) 업로드된 경로로 서명된 URL 생성 (5분 유효)
    const { data: signData, error: signErr } = await supabase.storage
      .from("podo-wiki")
      .createSignedUrl(uploadData.path, 300);
    if (signErr) {
      throw signErr;
    }

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
};

// presignedURL only API
exports.presignUrl = async (req, res) => {
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
};

exports.proxyImage = async (req, res) => {
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
    if (signErr) {
      throw signErr;
    }

    // 리다이렉트: 클라이언트 <img> 태그에서 바로 presigned URL로 전환
    res.redirect(signData.signedUrl);
  } catch (err) {
    console.error("GET /api/image-proxy Error:", err);
    res
      .status(500)
      .json({ message: "Signed URL 생성 중 오류 발생", error: err.message });
  }
};
