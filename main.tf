provider "google" {
  project = var.project_id
  region  = var.region
}

# Create a Cloud Storage Bucket for Function Source Code
resource "google_storage_bucket" "drive_to_gcs_bucket" {
  name          = "${var.project_id}-bucket"
  location      = var.region
  storage_class = "STANDARD"
}

# Upload Function Source Code as a Zip
resource "google_storage_bucket_object" "function_code" {
  name   = "function-source.zip"
  bucket = google_storage_bucket.drive_to_gcs_bucket.name
  source = "function-source.zip"
}

# Create a Service Account for the Function
resource "google_service_account" "drive_to_gcs_sa" {
  account_id   = "drive-to-gcs-sa"
  display_name = "Drive to GCS Service Account"
}

resource "google_project_iam_member" "gcs_object_admin" {
  project = var.project_id
  role    = "roles/storage.objectAdmin"  # Grants permissions to delete, read, and write objects
  member  = "serviceAccount:${google_service_account.drive_to_gcs_sa.email}"
}


resource "google_project_iam_member" "run_invoker" {
  project = var.project_id
  role    = "roles/run.invoker"
  member  = "serviceAccount:${google_service_account.drive_to_gcs_sa.email}"
}

# Deploy Cloud Run (Gen 2) Cloud Function (with HTTP Trigger)
resource "google_cloud_run_service" "drive_to_gcs_function" {
  name     = "transfer-file-service"
  location = var.region

  template {
    spec {
      containers {
        image = "gcr.io/${var.project_id}/transfer-file-image"
        env {
          name  = "BUCKET_NAME"
          value = google_storage_bucket.drive_to_gcs_bucket.name
        }
        ports {
          container_port = 8080
        }
      }
      service_account_name = google_service_account.drive_to_gcs_sa.email
    }
  }
}

# Allow unauthenticated invocations for Cloud Run (Gen 2)
resource "google_cloud_run_service_iam_member" "allow_unauthenticated" {
  service      = google_cloud_run_service.drive_to_gcs_function.name
  location     = var.region
  role         = "roles/run.invoker"
  member       = "allUsers"
}

# Create a Service Account for the Video Processor
resource "google_service_account" "video_processor_sa" {
  account_id   = "video-processor-sa"
  display_name = "Video Processor Service Account"
}

# Grant necessary permissions to the Video Processor Service Account
resource "google_project_iam_member" "video_processor_storage_viewer" {
  project = var.project_id
  role    = "roles/storage.objectViewer"
  member  = "serviceAccount:${google_service_account.video_processor_sa.email}"
}

# Deploy Video Processor as Cloud Run service
resource "google_cloud_run_service" "video_processor" {
  name     = "video-processor-service"
  location = var.region

  template {
    spec {
      containers {
        image = "gcr.io/${var.project_id}/video-processor-image"
        ports {
          container_port = 8080
        }
        env {
          name  = "GEMINI_API_KEY"
          value = var.gemini_api_key
        }
      }
      service_account_name = google_service_account.video_processor_sa.email
    }
  }
}

# Allow unauthenticated invocations for Video Processor
resource "google_cloud_run_service_iam_member" "video_processor_allow_unauthenticated" {
  service      = google_cloud_run_service.video_processor.name
  location     = var.region
  role         = "roles/run.invoker"
  member       = "allUsers"
}

resource "google_pubsub_topic_iam_member" "storage_notification_publisher" {
  topic = google_pubsub_topic.video_processing_topic.name
  role  = "roles/pubsub.publisher"
  member = "serviceAccount:service-540090171200@gs-project-accounts.iam.gserviceaccount.com"
}

# Create Cloud Storage notification for new video uploads
resource "google_storage_notification" "video_notification" {
  bucket         = google_storage_bucket.drive_to_gcs_bucket.name
  payload_format = "JSON_API_V1"
  topic          = google_pubsub_topic.video_processing_topic.name
  event_types    = ["OBJECT_FINALIZE"]
}

# Create Pub/Sub topic for video processing
resource "google_pubsub_topic" "video_processing_topic" {
  name = "video-processing-topic"
}

# Create Pub/Sub subscription
resource "google_pubsub_subscription" "video_processing_subscription" {
  name  = "video-processing-subscription"
  topic = google_pubsub_topic.video_processing_topic.name

  push_config {
    push_endpoint = google_cloud_run_service.video_processor.status[0].url
  }
}

# Grant Pub/Sub publisher role
resource "google_project_iam_member" "pubsub_publisher" {
  project = var.project_id
  role    = "roles/pubsub.publisher"
  member  = "serviceAccount:${google_service_account.video_processor_sa.email}"
}
