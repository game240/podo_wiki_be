const supabase = require("../config/supabaseClient");
const { applyPatch } = require("../utils/diffUtils");

// 스냅샷+델타를 순차 적용해서 원하는 rev_number 시점의 문서 콘텐츠를 복원하는 함수
const reconstructRevisionContent = async (page_id, target_rev_number) => {
  // 1-1) 가장 가까운 스냅샷 조회
  const { data: snap } = await supabase
    .from("revisions")
    .select("content, rev_number")
    .eq("page_id", page_id)
    .eq("is_snapshot", true)
    .lte("rev_number", target_rev_number)
    .order("rev_number", { ascending: false })
    .limit(1)
    .single();
  if (!snap) {
    // 스냅샷이 없으면 빈 객체 반환
    return {};
  }

  let doc = snap.content;

  // 1-2) 해당 스냅샷 이후부터 타겟 rev_number까지의 델타 리스트 조회
  const { data: deltas } = await supabase
    .from("revisions")
    .select("diff")
    .eq("page_id", page_id)
    .gt("rev_number", snap.rev_number)
    .lte("rev_number", target_rev_number)
    .order("rev_number", { ascending: true });

  if (!deltas) {
    return doc;
  }

  // 1-3) 순차적으로 패치 적용
  for (const { diff } of deltas || []) {
    doc = applyPatch(doc, diff, true).newDocument;
  }
  return doc;
};

module.exports = { reconstructRevisionContent };
