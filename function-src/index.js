const express = require("express");
const { google } = require("googleapis");
const { Storage } = require("@google-cloud/storage");
const fs = require("fs");
const path = require("path");

const app = express();
const storage = new Storage();
const drive = google.drive("v3");

app.get("/", async (req, res) => {
  try {
    console.log("🔹 Received request:", req.query);

    const fileId = req.query.fileId;
    if (!fileId) {
      console.error("❌ Missing fileId parameter");
      return res.status(400).send("Missing fileId parameter.");
    }

    console.log(`📂 Fetching metadata for File ID: ${fileId}`);

    const auth = new google.auth.GoogleAuth({
      scopes: ["https://www.googleapis.com/auth/drive.readonly"],
    });

    const driveAuth = await auth.getClient();

    const fileMetadata = await drive.files.get({
      auth: driveAuth,
      fileId: fileId,
      fields: "name, mimeType",
    });

    const fileName = fileMetadata.data.name;
    console.log(
      `📄 File Name: ${fileName}, MIME Type: ${fileMetadata.data.mimeType}`
    );

    const tempFilePath = path.join("/tmp", fileName);
    console.log(`📂 Downloading file to: ${tempFilePath}`);

    const dest = fs.createWriteStream(tempFilePath);
    await drive.files.get(
      { auth: driveAuth, fileId: fileId, alt: "media" },
      { responseType: "stream" },
      (err, response) => {
        if (err) {
          console.error("❌ Error downloading file:", err);
          return res.status(500).send("Download error.");
        }

        response.data
          .on("end", async () => {
            console.log(`✅ Successfully downloaded: ${fileName}`);

            const bucketName = process.env.BUCKET_NAME;
            console.log(
              `🚀 Uploading ${fileName} to GCS bucket: ${bucketName}`
            );

            try {
              await storage.bucket(bucketName).upload(tempFilePath, {
                destination: fileName,
              });
              console.log(`✅ Successfully uploaded ${fileName} to GCS`);
              res
                .status(200)
                .send(`File ${fileName} transferred successfully.`);
            } catch (uploadError) {
              console.error("❌ Error uploading to GCS:", uploadError);
              res.status(500).send("Upload error.");
            }
          })
          .pipe(dest);
      }
    );
  } catch (error) {
    console.error("❌ Unexpected Error:", error);
    res.status(500).send("Error transferring file.");
  }
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
