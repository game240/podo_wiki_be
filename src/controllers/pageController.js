const supabase = require("../config/supabaseClient");
const { compare, applyPatch, summarizeDiffs } = require("../utils/diffUtils");
const authenticate = require("../middleware/auth");

const SNAPSHOT_THRESHOLD = 50;

exports.savePage = [
  authenticate,
  async (req, res) => {
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
        // 1-1) 현재 리비전 정보 조회 (rev_number, content)
        const { data: lastRev, error: revErr } = await supabase
          .from("revisions")
          .select("rev_number, content")
          .eq("id", page.current_rev)
          .single();
        if (revErr) throw revErr;

        // 1-2) pages 테이블에 저장된 최신 전체 문서 조회
        const { data: pageRow, error: pageErr } = await supabase
          .from("pages")
          .select("content")
          .eq("id", page.id)
          .single();
        if (pageErr) throw pageErr;

        let pageContent = pageRow.content;
        if (typeof pageContent === "string") {
          pageContent = JSON.parse(pageContent);
        }
        // revision.content가 null이면 전체 문서(pages.content)를, 아니면 revision.content를 사용
        baseDoc = lastRev.content ?? pageContent;
        lastRevNumber = lastRev.rev_number;
      }

      // diff 계산
      const base = baseDoc ?? {};
      const patch = compare(
        base,
        content,
        /* invertible */ true,
        /* options */ { includeMove: true, includeValueOnRemove: true }
      );
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
  },
];

const reconstructRevisionContent = async (page_id, target_rev_number) => {
  // 1-1) 가장 가까운 스냅샷 조회
  const { data: snap, error: snapErr } = await supabase
    .from("revisions")
    .select("content, rev_number")
    .eq("page_id", page_id)
    .eq("is_snapshot", true)
    .lte("rev_number", target_rev_number)
    .order("rev_number", { ascending: false })
    .limit(1)
    .single();
  if (snapErr || !snap) return {};

  let doc = snap.content;
  const snapRev = snap.rev_number;

  // 1-2) 스냅샷 이후 target_rev_number까지의 델타 조회
  const { data: deltas, error: deltaErr } = await supabase
    .from("revisions")
    .select("diff")
    .eq("page_id", page_id)
    .gt("rev_number", snapRev)
    .lte("rev_number", target_rev_number)
    .order("rev_number", { ascending: true });
  if (deltaErr) return doc;

  // 1-3) 델타 순차 적용
  for (const { diff } of deltas) {
    const { newDocument } = applyPatch(doc, diff, /*validate=*/ true);
    doc = newDocument;
  }

  return doc;
};

// 7) 리비전 조회 by title (Flat 검색)
exports.getPage = async (req, res) => {
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
    const doc = await reconstructRevisionContent(pageId, currNum);

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
};
