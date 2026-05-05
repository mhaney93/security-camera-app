// Picks Cloudflare R2 (production) or local disk (local dev) based on env
const fs = require('fs');
const path = require('path');

const USE_R2 = !!(process.env.R2_ACCOUNT_ID && process.env.R2_ACCESS_KEY_ID);

const uploadsDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });

let r2Client;
function r2() {
  if (!r2Client) {
    const { S3Client } = require('@aws-sdk/client-s3');
    r2Client = new S3Client({
      region: 'auto',
      endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
      credentials: {
        accessKeyId: process.env.R2_ACCESS_KEY_ID,
        secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
      },
    });
  }
  return r2Client;
}

// Move a multer-saved file into permanent storage (R2 or local uploads/)
async function storeRecording(localPath, key) {
  if (USE_R2) {
    const { PutObjectCommand } = require('@aws-sdk/client-s3');
    const stat = fs.statSync(localPath);
    await r2().send(new PutObjectCommand({
      Bucket: process.env.R2_BUCKET_NAME,
      Key: key,
      Body: fs.createReadStream(localPath),
      ContentLength: stat.size,
      ContentType: 'video/webm',
    }));
    fs.unlink(localPath, () => {});
  } else {
    // Just leave the file where multer already put it (inside uploads/)
    // If multer wrote to a tmp subdir, move it; here multer writes directly to uploads/ so no-op
  }
}

// Stream a stored recording into an Express response
async function streamRecording(key, res) {
  if (USE_R2) {
    const { GetObjectCommand } = require('@aws-sdk/client-s3');
    const obj = await r2().send(new GetObjectCommand({
      Bucket: process.env.R2_BUCKET_NAME,
      Key: key,
    }));
    res.setHeader('Content-Type', obj.ContentType || 'video/webm');
    if (obj.ContentLength) res.setHeader('Content-Length', String(obj.ContentLength));
    obj.Body.pipe(res);
  } else {
    const file = path.join(uploadsDir, path.basename(key));
    if (!fs.existsSync(file)) throw new Error('Not found');
    res.setHeader('Content-Type', 'video/webm');
    res.setHeader('Accept-Ranges', 'bytes');
    fs.createReadStream(file).pipe(res);
  }
}

async function deleteRecording(key) {
  if (USE_R2) {
    const { DeleteObjectCommand } = require('@aws-sdk/client-s3');
    await r2().send(new DeleteObjectCommand({
      Bucket: process.env.R2_BUCKET_NAME,
      Key: path.basename(key),
    }));
  } else {
    const file = path.join(uploadsDir, path.basename(key));
    if (fs.existsSync(file)) fs.unlinkSync(file);
  }
}

module.exports = { storeRecording, streamRecording, deleteRecording, uploadsDir, USE_R2 };
