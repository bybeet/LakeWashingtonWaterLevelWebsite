# Lake Washington Water Level website

A static page (`index.html`, `app.js`, `styles.css`) that charts Lake Washington's water level. It loads `data.csv` from next to `index.html`, which the [scraper](https://github.com/bybeet/lake-washington-water-level) writes to the same S3 bucket.

The site is served at https://lake.brewops.dev by CloudFront from the private bucket `lake-washington-water-level-823580404672` (us-west-2).

## Infrastructure

Terraform in `infra/` manages:

- an ACM certificate for `lake.brewops.dev` (us-east-1), with DNS validation
- a WAF web ACL (us-east-1): a 500 requests / 5 min per-IP rate limit, plus the AWS IP reputation and common rule sets
- the CloudFront distribution and its origin access control
- the bucket policy, which lets only this distribution read `index.html`, `app.js`, `styles.css` and `data.csv`. Everything else in the bucket (`data.json`, `backup/`) stays private.

The bucket itself belongs to the scraper's Terraform and is only read here with a data source. DNS for `brewops.dev` (Cloudflare) is managed outside Terraform.

### Apply

**Prerequisites:** Terraform and the AWS CLI v2 signed in to account `823580404672`.

```bash
aws login
unset AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY AWS_SESSION_TOKEN
eval $(aws configure export-credentials --format env)

cd infra
terraform init

# 1. Request the certificate and get its validation record
terraform apply -target=aws_acm_certificate.site
terraform output cert_validation_records
```

2. In Cloudflare, create the validation CNAME from that output, **DNS only** (not proxied).

```bash
# 3. Create everything else. This waits until ACM sees the record and issues the certificate.
terraform apply
terraform output distribution_domain_name
```

4. In Cloudflare, create `lake` as a CNAME to the distribution domain name, **DNS only**. Proxying through Cloudflare would put a second CDN in front of CloudFront and break its caching and TLS.

Keep the validation CNAME in place: ACM uses it to renew the certificate automatically.

### Subscribe to the CloudFront Free plan (manual)

The plan subscription is not managed by Terraform, so do this after the first `apply` (in the console, or with the PricingPlanManager CLI/API):

1. Open the CloudFront console and select the distribution (`terraform output distribution_id`).
2. Choose the pricing plan option and subscribe the distribution to the **Free** plan.

The Free plan does not allow `forwarded_values`, custom cache policies, OAI or real-time logs, so keep those out of `infra/`.

> **Before `terraform destroy`:** cancel the Free plan subscription first. CloudFront won't delete a distribution that is still on a pricing plan.

## Deploy the site

```bash
./deploy.sh            # upload index.html, app.js, styles.css
./deploy.sh --dry-run  # show what would be uploaded
```

The files are uploaded with `Cache-Control: no-cache`, so a deploy shows up on the next page load. `deploy.sh` never touches `data.csv`.

## Checks

```bash
curl -sI https://lake.brewops.dev/                                       # 200, content-type: text/html
curl -sI http://lake.brewops.dev/                                        # 301 to https
curl -sI -H 'Accept-Encoding: br' https://lake.brewops.dev/data.csv      # 200, content-encoding: br, text/csv, max-age=3600
curl -sI https://lake.brewops.dev/data.json                              # 403
curl -sI https://lake.brewops.dev/backup/                                # 403
curl -sI https://lake-washington-water-level-823580404672.s3.us-west-2.amazonaws.com/data.csv  # 403
```
