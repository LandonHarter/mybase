---
title: Storage (S3)
summary: Use a project's S3 bucket with any S3 client; serve public files from the public/ prefix.
section: Services
order: 11
---

# Storage (S3)

Every project has a bucket on Garage, an S3-compatible store. `mybase project create` prints the endpoint, region (`garage`), bucket, access key id, and secret key (once).

## Use it from an app

Any S3 client works. Use path-style addressing:

```ts
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";

const s3 = new S3Client({
  endpoint: process.env.S3_ENDPOINT,
  region: process.env.S3_REGION, // "garage"
  forcePathStyle: true,
  credentials: { accessKeyId: process.env.S3_ACCESS_KEY_ID!, secretAccessKey: process.env.S3_SECRET_ACCESS_KEY! },
});

await s3.send(new PutObjectCommand({ Bucket: process.env.S3_BUCKET, Key: "public/logo.png", Body: bytes }));
```

Bun's built-in `S3Client` and `aws4fetch` work too.

## Public files

Objects whose key starts with `public/` are readable by anyone at:

```
{{MYBASE_URL}}/storage/<project>/public/<rest of key>
```

Everything else needs the S3 credentials (or a presigned URL from your app).

## Browse files

Dashboard → Storage, or `GET /projects/<p>/files?prefix=<folder/>` with `storage:read` (MCP `list_files`).

## Agent notes

- The bucket name is the project name with `_` replaced by `-`.
- Set `forcePathStyle: true` (AWS SDK) or the client tries `<bucket>.<host>` and fails.
- Through a Cloudflare Tunnel, single requests over 100 MB fail; use multipart uploads.
