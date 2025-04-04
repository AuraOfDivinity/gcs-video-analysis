function checkNewFilesAndTriggerCloudFunction() {
  const FOLDER_ID = "dummy-folder-id";
  const CLOUD_FUNCTION_URL =
    "https://dummy-cloud-function-540090171200.us-central1.run.app";
  const processedFilesKey = "processed_file_ids";

  // Get processed file IDs from PropertiesService
  const scriptProperties = PropertiesService.getScriptProperties();
  let processedFiles = JSON.parse(
    scriptProperties.getProperty(processedFilesKey) || "[]"
  );

  // Get the folder and list files
  const folder = DriveApp.getFolderById(FOLDER_ID);
  const files = folder.getFiles();

  let newFiles = [];

  while (files.hasNext()) {
    const file = files.next();
    const fileId = file.getId();

    // If file is already processed, skip it
    if (!processedFiles.includes(fileId)) {
      newFiles.push(fileId);
    }
  }

  // Process new files
  if (newFiles.length > 0) {
    newFiles.forEach((fileId) => {
      try {
        // Construct the URL with the fileId as a query parameter
        const requestUrl = `${CLOUD_FUNCTION_URL}?fileId=${encodeURIComponent(
          fileId
        )}`;

        // Make a GET request to the Cloud Function
        const options = {
          method: "get",
          muteHttpExceptions: true,
        };

        const response = UrlFetchApp.fetch(requestUrl, options);
        const statusCode = response.getResponseCode();

        console.log(
          `File ID ${fileId} sent to Cloud Function. Response Code: ${statusCode}`
        );

        // If Cloud Function accepts it, mark it as processed
        if (statusCode >= 200 && statusCode < 300) {
          processedFiles.push(fileId);
        }
      } catch (error) {
        console.error(`Error sending file ${fileId}: ${error.message}`);
      }
    });

    // Save updated processed file IDs
    scriptProperties.setProperty(
      processedFilesKey,
      JSON.stringify(processedFiles)
    );
  } else {
    console.log("No new files found.");
  }
}
