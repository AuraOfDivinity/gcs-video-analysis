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
