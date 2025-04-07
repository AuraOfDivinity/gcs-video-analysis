variable "project_id" {
  description = "The project ID to deploy to"
  type        = string
}

variable "region" {
  description = "The region to deploy to"
  type        = string
}

variable "gemini_api_key" {
  description = "API key for Google's Gemini AI"
  type        = string
  sensitive   = true
}