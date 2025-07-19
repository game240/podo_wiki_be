const express = require("express");
// const fs = require("fs");
// const path = require("path");
const { compare, applyPatch } = require("fast-json-patch");
const { Node: PMNode } = require("prosemirror-model");
const { schema: basicSchema } = require("prosemirror-schema-basic");

const app = express();

const cors = require("cors");
app.use(cors());

// 1) 클라이언트에서 JSON 바디를 받을 수 있도록 설정
app.use(express.json());

// 2) 파일 저장용 디렉토리 (없으면 생성)
// const DATA_DIR = path.join(__dirname, "../data");
// if (!fs.existsSync(DATA_DIR)) {
//   fs.mkdirSync(DATA_DIR, { recursive: true });
// }

// // 3) /api/save 엔드포인트: { filename, content } 수신 후 파일 저장
// app.post("/api/save", async (req, res) => {
//   try {
//     const { filename, content, meta } = req.body;
//     if (!filename || !content) {
//       return res
//         .status(400)
//         .json({ message: "filename, content가 필요합니다." });
//     }
//     const safeName = filename.replace(/[^a-zA-Z0-9_\-\.]/g, "_");
//     const filePath = path.join(DATA_DIR, safeName);

//     // JSON 형태로 저장 (pretty-print 옵션)
//     const toWrite = { meta, content };
//     await fs.promises.writeFile(
//       filePath,
//       JSON.stringify(toWrite, null, 2),
//       "utf8"
//     );

//     res.json({ message: "파일 저장 성공", path: `/data/${safeName}` });
//   } catch (err) {
//     console.error(err);
//     res.status(500).json({ message: "서버 오류", error: err.message });
//   }
// });

// app.get("/api/page/:filename", async (req, res) => {
//   try {
//     const safeName = req.params.filename.replace(/[^a-zA-Z0-9_\-\.]/g, "_");
//     const filePath = path.join(DATA_DIR, safeName);
//     const raw = await fs.promises.readFile(filePath, "utf8");
//     const parsed = JSON.parse(raw);
//     res.json(parsed); // { meta: {...}, content: { ... } }
//   } catch {
//     res.status(404).json({ message: "파일을 찾을 수 없습니다." });
//   }
// });

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

// 6) 리비전 저장
const SNAPSHOT_THRESHOLD = 50;

app.post("/api/page", async (req, res) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      return res.status(401).json({ error: "Unauthorized" });
    }
    const token = authHeader.split(" ")[1];

    const {
      data: { user },
      error: userError,
    } = await supabase.auth.getUser(token);
    if (userError || !user) {
      console.error("getUser error:", userError);
      return res.status(401).json({ error: "Invalid token" });
    }

    const { title, content, summary } = req.body;
    if (!title || !content) {
      return res.status(400).json({ error: "title과 content가 필요합니다." });
    }

    // 페이지 조회/생성
    let { data: page, error } = await supabase
      .from("pages")
      .select("id, current_rev")
      .eq("title", title)
      .maybeSingle();
    if (error) throw error;

    if (!page) {
      const { data: inserted, error: err2 } = await supabase
        .from("pages")
        .insert({ title, created_by: user.id })
        .select("id, current_rev")
        .single();
      if (err2) throw err2;
      page = inserted;
    }

    // 마지막 리비전 가져오기
    let baseDoc = null;
    let lastRevNumber = 0;
    if (page.current_rev) {
      const { data: lastRev, error: revErr } = await supabase
        .from("revisions")
        .select("rev_number, content")
        .eq("id", page.current_rev)
        .single();
      if (revErr) throw revErr;
      baseDoc = lastRev.content;
      lastRevNumber = lastRev.rev_number;
    }

    // diff 계산
    const base = baseDoc ?? [];
    const patch = compare(base, content);
    const isSnapshot =
      // 최초 리비전이거나,
      !baseDoc ||
      // (리비전 번호 % SNAPSHOT_THRESHOLD === 0)일 때 스냅샷
      (lastRevNumber + 1) % SNAPSHOT_THRESHOLD === 0;
    const newRevNumber = lastRevNumber + 1;

    // revisions 테이블에 저장
    const { data: newRev, error: insertErr } = await supabase
      .from("revisions")
      .insert({
        page_id: page.id,
        rev_number: newRevNumber,
        is_snapshot: isSnapshot,
        content: isSnapshot ? content : null,
        diff: patch,
        base_rev: isSnapshot ? null : page.current_rev,
        summary: summary || null,
        created_by: user.id,
      })
      .select("id")
      .single();
    if (insertErr) throw insertErr;

    const doc = isSnapshot
      ? content
      : applyPatch(baseDoc, patch, true).newDocument;

    // pages.current_rev, pages.content 갱신
    const { error: updateErr } = await supabase
      .from("pages")
      .update({
        current_rev: newRev.id,
        updated_at: new Date().toISOString(),
        content: doc,
      })
      .eq("id", page.id);
    if (updateErr) throw updateErr;

    res.json({
      message: "페이지 저장 성공",
      page_id: page.id,
      revision_id: newRev.id,
      rev_number: newRevNumber,
      is_snapshot: isSnapshot,
    });
  } catch (err) {
    console.error("SAVE PAGE ERROR:", err);
    res.status(500).json({ error: err.message });
  }
});

// 7) 리비전 조회 by title (Flat 검색)
app.get("/api/page", async (req, res) => {
  try {
    const { title } = req.query;
    if (!title) {
      return res
        .status(400)
        .json({ error: "title 쿼리 파라미터가 필요합니다." });
    }

    // 1) title로 페이지 메타 조회
    const { data: page, error: pageErr } = await supabase
      .from("pages")
      .select("id, current_rev, title, created_at, updated_at")
      .eq("title", title)
      .maybeSingle();
    if (pageErr) throw pageErr;
    if (!page || !page.current_rev) {
      return res
        .status(404)
        .json({ error: "페이지를 찾을 수 없거나 리비전이 존재하지 않습니다." });
    }
    const pageId = page.id;
    const currentRevId = page.current_rev;

    // 2) current_rev의 rev_number 조회
    const { data: currRev, error: currRevErr } = await supabase
      .from("revisions")
      .select("rev_number")
      .eq("id", currentRevId)
      .single();
    if (currRevErr) throw currRevErr;
    const currNum = currRev.rev_number;

    // 3) 가장 가까운 스냅샷 조회
    const { data: snap, error: snapErr } = await supabase
      .from("revisions")
      .select("content, rev_number")
      .eq("page_id", pageId)
      .eq("is_snapshot", true)
      .lte("rev_number", currNum)
      .order("rev_number", { ascending: false })
      .limit(1)
      .single();
    if (snapErr) throw snapErr;
    let doc = snap.content;
    const snapNum = snap.rev_number;

    // 4) 스냅샷 이후 델타 조회
    const { data: deltas, error: deltaErr } = await supabase
      .from("revisions")
      .select("diff")
      .eq("page_id", pageId)
      .gt("rev_number", snapNum)
      .lte("rev_number", currNum)
      .order("rev_number", { ascending: true });
    if (deltaErr) throw deltaErr;

    // 5) patch 순차 적용
    for (const { diff } of deltas) {
      const { newDocument } = applyPatch(doc, diff, true);
      doc = newDocument;
    }

    // 분류 가져오기
    const { data: cats, error: catErr } = await supabase
      .from("page_categories")
      .select(
        `
        category_id,
        ord,                   
        category:categories (   
          id,               
          name              
        )
      `
      )
      .eq("page_id", pageId);

    if (catErr) throw catErr;

    // cats 결과 예시
    // [
    //   { category_id: 'd75da8e2-…', ord: 0, category: { id: 'd75da8e2-…', name: '테스트' } },
    //   …
    /// ]

    // 최종적으로는 원하는 형태로 매핑 [{ category_id, name }, { category_id, name }, ...]
    const categories = cats.map(({ category_id, ord, category }) => ({
      category_id,
      name: category.name,
    }));

    // 6) 최종 문서 반환
    return res.json({
      meta: {
        id: page.id,
        title: page.title,
        created_at: page.created_at,
        updated_at: page.updated_at,
        author_id: page.author_id,
        current_rev: page.current_rev,
        current_rev_number: currNum,
        categories,
      },
      content: doc,
    });
  } catch (err) {
    console.error("GET PAGE ERROR:", err);
    return res.status(500).json({ error: err.message });
  }
});

app.get("/api/search", async (req, res) => {
  const q = String(req.query.q || "").trim();
  if (!q) return res.status(400).json({ error: "검색어(q)를 전달하세요." });

  const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
  const pageSize = Math.max(parseInt(req.query.pageSize, 10) || 20, 1);
  const from = (page - 1) * pageSize;

  const { data, error: rpcError } = await supabase.rpc("search_pages", {
    _q: q,
    _from: from,
    _limit: pageSize,
  });
  if (rpcError) {
    console.error("RPC 에러:", rpcError);
    return res.status(500).json({ error: rpcError.message });
  }

  const total = data.length > 0 ? Number(data[0].total_count) : 0;
  const totalPages = Math.ceil(total / pageSize);

  res.json({ data, pagination: { total, page, pageSize, totalPages } });
});

app.get("/api/search-autocomplete", async (req, res) => {
  const q = String(req.query.q || "").trim();
  if (!q) {
    return res.json([]);
  }

  try {
    const { data, error } = await supabase
      .from("pages")
      .select("title")
      .ilike("title", `${q}%`)
      .order("title", { ascending: true })
      .limit(10);

    if (error) throw error;

    // [{ title: '…' }, …] → ['…', …]
    const titles = data.map((r) => r.title);
    res.json(titles);
  } catch (err) {
    console.error("AUTOCOMPLETE ERROR:", err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/recent-change?limit=10&offset=0
app.get("/api/recent-change", async (req, res) => {
  try {
    // 쿼리파라미터 파싱 (기본값 limit=10, offset=0)
    const limit = Math.max(parseInt(req.query.limit, 10) || 10, 1);
    const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);
    const start = offset;
    const end = offset + limit - 1;

    // revisions 테이블에서 최신순으로 join 조회
    const { data, error } = await supabase
      .from("revisions")
      .select(
        `
        id,
        page_id,
        rev_number,
        diff,
        created_at,
        pages!revisions_page_id_fkey ( title ),
        profiles!revisions_created_by_profiles_fkey ( nickname )
      `
      )
      .order("created_at", { ascending: false })
      .limit(limit)
      .range(start, end);

    if (error) throw error;

    // 응답 포맷 가공
    const changes = data.map((r) => ({
      revision_id: r.id,
      page_id: r.page_id,
      title: r.pages.title,
      modifier: r.profiles.nickname,
      edited_at: r.created_at,
      rev_number: r.rev_number,
      diff: r.diff,
    }));

    res.json({ changes });
  } catch (err) {
    console.error("GET /api/revisions/recent Error:", err);
    res
      .status(500)
      .json({ message: "최근 변경내역 조회 중 오류 발생", error: err.message });
  }
});

// 4) 서버 시작
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ Server running on http://localhost:${PORT}`);
});
