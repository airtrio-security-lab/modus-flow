-- MODUS FLOW · Source channel «Мессенджер» (WhatsApp, Telegram…).
-- Owner (2026-11-10): ideas get lost in WhatsApp chats as much as at meetings
-- and in e-mail; a message forwarded from a chat is recorded with this source.
ALTER TABLE ideas DROP CONSTRAINT ideas_source_channel_check;
ALTER TABLE ideas ADD CONSTRAINT ideas_source_channel_check
  CHECK (source_channel IN ('app','meeting','email','phone','conversation','messenger','other'));
