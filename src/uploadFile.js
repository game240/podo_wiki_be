// uploadFile.js
const fs = require("fs");
const path = require("path");
const supabase = require("./supabaseClient");

async function uploadLocalFile(localFilePath) {
  const fileName = path.basename(localFilePath);
  const fileStream = fs.createReadStream(localFilePath);

  const { data, error } = await supabase.storage
    .from("podo-wiki") // 버킷 이름
    .upload(`public/${fileName}`, fileStream, {
      cacheControl: "3600",
      upsert: false,
    });

  if (error) throw error;
  console.log("Uploaded path:", data.path);

  // 공개 URL 얻기
  const { publicURL, error: urlError } = supabase.storage
    .from("podo-wiki")
    .getPublicUrl(data.path);

  if (urlError) throw urlError;
  console.log("Public URL:", publicURL);
}
