const supabase = require("../config/supabaseClient");
const {
  compare,
  applyPatch,
  summarizeDiffs,
  docToText,
  gitLikeDiff,
  summarizeGitOps,
  createUnifiedPatch,
} = require("../utils/diffUtils");
const authenticate = require("../middleware/auth");
const { reconstructRevisionContent } = require("../services/revisionServices");

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
      const withLineDiff = String(req.query.with_line_diff || "") === "1";
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

      // 마지막 리비전/베이스 문서
      let baseDoc = null;
      let lastRevNumber = 0;
      if (page.current_rev) {
        const { data: lastRev, error: revErr } = await supabase
          .from("revisions")
          .select("rev_number, content")
          .eq("id", page.current_rev)
          .single();
        if (revErr) throw revErr;

        const { data: pageRow, error: pageErr } = await supabase
          .from("pages")
          .select("content")
          .eq("id", page.id)
          .single();
        if (pageErr) throw pageErr;

        let pageContent = pageRow.content;
        if (typeof pageContent === "string")
          pageContent = JSON.parse(pageContent);

        baseDoc = lastRev.content ?? pageContent;
        lastRevNumber = lastRev.rev_number;
      }

      // JSON Patch diff 계산/스냅샷 여부
      const base = baseDoc ?? {};
      const patch = compare(
        base,
        content,
        /* invertible */ true,
        /* options */ { includeMove: true, includeValueOnRemove: true }
      );
      const isSnapshot =
        !baseDoc || (lastRevNumber + 1) % SNAPSHOT_THRESHOLD === 0;
      const newRevNumber = lastRevNumber + 1;

      // revisions 저장
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

      // 새 문서
      const doc = isSnapshot
        ? content
        : applyPatch(baseDoc, patch, true).newDocument;

      // pages 갱신
      const { error: updateErr } = await supabase
        .from("pages")
        .update({
          current_rev: newRev.id,
          updated_at: new Date().toISOString(),
          content: doc,
        })
        .eq("id", page.id);
      if (updateErr) throw updateErr;

      // (옵션) Git-like 라인 diff 계산
      let lineDiffOps, lineDiffSummary, unifiedPatch;
      if (withLineDiff) {
        const oldText = docToText(base);
        const newText = docToText(content);
        lineDiffOps = gitLikeDiff(oldText, newText, { withIntraLine: true });
        lineDiffSummary = summarizeGitOps(lineDiffOps);
        unifiedPatch = createUnifiedPatch(
          oldText,
          newText,
          `${title}@${lastRevNumber || 0}`,
          `${title}@${newRevNumber}`,
          /*context*/ 3
        );
      }

      res.json({
        message: "페이지 저장 성공",
        page_id: page.id,
        revision_id: newRev.id,
        rev_number: newRevNumber,
        is_snapshot: isSnapshot,
        json_patch_summary: summarizeDiffs ? summarizeDiffs(patch) : undefined,
        line_diff: withLineDiff
          ? {
              ops: lineDiffOps,
              summary: lineDiffSummary,
              unified_patch: unifiedPatch,
            }
          : undefined,
      });
    } catch (err) {
      console.error("SAVE PAGE ERROR:", err);
      res.status(500).json({ error: err.message });
    }
  },
];

// 7) 리비전 조회 by title (Flat 검색)
exports.getPage = async (req, res) => {
  try {
    const { title } = req.query;
    if (!title) {
      return res
        .status(400)
        .json({ error: "title 쿼리 파라미터가 필요합니다." });
    }

    const { data: page, error: pageErr } = await supabase
      .from("pages")
      .select("id, current_rev, title, created_at, updated_at, created_by")
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

    const { data: currRev, error: currRevErr } = await supabase
      .from("revisions")
      .select("rev_number")
      .eq("id", currentRevId)
      .single();
    if (currRevErr) throw currRevErr;
    const currNum = currRev.rev_number;

    const doc = await reconstructRevisionContent(pageId, currNum);

    // TODO: categories service로 refactor
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

    const categories = (cats || []).map(({ category_id, category }) => ({
      category_id,
      name: category.name,
    }));

    return res.json({
      meta: {
        id: page.id,
        title: page.title,
        created_at: page.created_at,
        updated_at: page.updated_at,
        created_by: page.created_by,
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

exports.getRevisionById = async (req, res) => {
  try {
    const { revision_id } = req.params;

    const { data: revRow, error } = await supabase
      .from("revisions")
      .select(
        "id, page_id, rev_number, created_at, created_by, is_snapshot, content"
      )
      .eq("id", revision_id)
      .maybeSingle();

    if (error) throw error;
    if (!revRow)
      return res.status(404).json({ error: "해당 리비전을 찾을 수 없습니다." });

    const { data: page } = await supabase
      .from("pages")
      .select("id, title, created_at, updated_at, created_by, current_rev")
      .eq("id", revRow.page_id)
      .maybeSingle();

    const doc = revRow.is_snapshot
      ? revRow.content
      : await reconstructRevisionContent(revRow.page_id, revRow.rev_number);

    // TODO: categories service로 refactor
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
      .eq("page_id", revRow.page_id);
    if (catErr) throw catErr;

    const categories = (cats || []).map(({ category_id, category }) => ({
      category_id,
      name: category.name,
    }));

    return res.json({
      meta: {
        id: page.id,
        title: page.title,
        created_at: page.created_at,
        updated_at: page.updated_at,
        created_by: page.created_by,
        current_rev: page.current_rev,
        current_rev_number: revRow.rev_number,
        categories,
      },
      content: doc,
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
};
