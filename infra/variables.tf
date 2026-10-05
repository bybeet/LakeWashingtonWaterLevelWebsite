variable "domain_name" {
  description = "Hostname the site is served on"
  type        = string
  default     = "lake.brewops.dev"
}

variable "bucket_name" {
  description = "Existing S3 bucket holding the site files and data.csv (not managed here)"
  type        = string
  default     = "lake-washington-water-level-823580404672"
}
