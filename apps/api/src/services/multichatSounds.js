"use strict";

/**
 * MultichatSoundsService — the streamer's uploaded custom alert
 * sounds. Small audio files (MP3/OGG/WAV) stored inline in Mongo
 * (well under the document limit at these caps) and served on the
 * overlay token route, so the OBS Browser Source can fetch them with
 * the token as its only credential — same threat model as every
 * other overlay surface.
 *
 * Caps are deliberately tight: alert sounds are seconds long, and
 * the config route ships METADATA only — audio bytes never ride in
 * the 60-second config poll.
 */

const { randomUUID } = require("crypto");

const MAX_SOUNDS_PER_USER = 5;
const MAX_BYTES = 300 * 1024;
const LABEL_MAX = 40;

/**
 * Magic-byte sniff — accept only real audio containers.
 *
 * @param {Buffer} buf
 */
function sniffMime(buf) {
  if (buf.length < 4) return null;
  // MP3: ID3 tag or MPEG frame sync (0xFFEx/0xFFFx)
  if (buf[0] === 0x49 && buf[1] === 0x44 && buf[2] === 0x33) return "audio/mpeg";
  if (buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0) return "audio/mpeg";
  // OGG
  if (buf[0] === 0x4f && buf[1] === 0x67 && buf[2] === 0x67 && buf[3] === 0x53) {
    return "audio/ogg";
  }
  // WAV (RIFF....WAVE)
  if (
    buf.length >= 12 &&
    buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46 &&
    buf[8] === 0x57 && buf[9] === 0x41 && buf[10] === 0x56 && buf[11] === 0x45
  ) {
    return "audio/wav";
  }
  return null;
}

class MultichatSoundsService {
  /**
   * @param {{ multichatSounds: import('mongodb').Collection }} db
   */
  constructor(db) {
    this.col = db.multichatSounds;
  }

  /**
   * Store an uploaded sound. Throws coded errors the routes map to
   * structured 4xx responses.
   *
   * @param {string} userId
   * @param {string} label
   * @param {Buffer} bytes
   */
  async create(userId, label, bytes) {
    const cleanLabel = String(label ?? "").trim().slice(0, LABEL_MAX);
    if (!cleanLabel) {
      throw Object.assign(new Error("label required"), { code: "bad_label" });
    }
    if (!Buffer.isBuffer(bytes) || bytes.length === 0) {
      throw Object.assign(new Error("empty file"), { code: "bad_file" });
    }
    if (bytes.length > MAX_BYTES) {
      throw Object.assign(
        new Error(`file exceeds ${Math.round(MAX_BYTES / 1024)} KB`),
        { code: "too_large" },
      );
    }
    const mime = sniffMime(bytes);
    if (!mime) {
      throw Object.assign(new Error("not a recognized audio file (MP3/OGG/WAV)"), {
        code: "bad_format",
      });
    }
    const count = await this.col.countDocuments({ userId });
    if (count >= MAX_SOUNDS_PER_USER) {
      throw Object.assign(
        new Error(`limit of ${MAX_SOUNDS_PER_USER} uploaded sounds reached`),
        { code: "too_many" },
      );
    }
    const soundId = randomUUID();
    await this.col.insertOne({
      userId,
      soundId,
      label: cleanLabel,
      mime,
      size: bytes.length,
      data: bytes,
      createdAt: new Date(),
    });
    return { soundId, label: cleanLabel, mime, size: bytes.length };
  }

  /** @param {string} userId */
  async list(userId) {
    const docs = await this.col
      .find({ userId }, { projection: { _id: 0, data: 0, userId: 0 } })
      .sort({ createdAt: 1 })
      .toArray();
    return docs;
  }

  /**
   * @param {string} userId
   * @param {string} soundId
   */
  async remove(userId, soundId) {
    const res = await this.col.deleteOne({ userId, soundId: String(soundId) });
    return res.deletedCount === 1;
  }

  /**
   * Fetch bytes for serving — scoped by OWNER, so a token route must
   * resolve its token to the owning user first.
   *
   * @param {string} userId
   * @param {string} soundId
   */
  async getForServe(userId, soundId) {
    const doc = await this.col.findOne(
      { userId, soundId: String(soundId) },
      { projection: { _id: 0, mime: 1, size: 1, data: 1 } },
    );
    if (!doc) return null;
    const data = doc.data?.buffer
      ? Buffer.from(doc.data.buffer)
      : Buffer.from(doc.data);
    return { mime: doc.mime, size: doc.size, data };
  }
}

module.exports = {
  MultichatSoundsService,
  MAX_SOUNDS_PER_USER,
  MAX_BYTES,
  sniffMime,
};
