// Pending attachments for the message currently being composed.
//
// Each entry is { id, kind, filename, uploading, previewUrl }. A file gets a
// temporary id and uploads in the background; when the upload finishes the
// entry is swapped for the server's record (whose id names the stored file).
// previewUrl is a local object URL so images render instantly in the composer
// and in the sent bubble, without waiting on a /uploads round-trip.

import { useState, useRef } from 'react';
import * as api from '../api/client';

export function useAttachments() {
  const [pendingAttachments, setPendingAttachments] = useState([]);
  const fileInputRef = useRef(null);

  const openFilePicker = () => fileInputRef.current?.click();

  // Handles the hidden <input type="file"> change event.
  const onFileSelect = async (e) => {
    const files = Array.from(e.target.files || []);
    e.target.value = ''; // let the same file be picked again later
    for (const file of files) {
      const t = file.type || '';
      // The vision/audio stack decodes raster images and audio only. SVG is
      // vector (not decodable) and video isn't wired up — reject both clearly.
      const supported = (t.startsWith('image/') && t !== 'image/svg+xml') || t.startsWith('audio/');
      if (!supported) {
        alert(`"${file.name}" isn't supported.\nYou can attach raster images (PNG, JPG, GIF, WebP) and audio files.`);
        continue;
      }
      const tempId = `tmp-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      const kind = t.startsWith('image/') ? 'image' : 'audio';
      const previewUrl = kind === 'image' ? URL.createObjectURL(file) : null;
      setPendingAttachments((prev) => [
        ...prev,
        { id: tempId, kind, filename: file.name, uploading: true, previewUrl },
      ]);
      try {
        const info = await api.uploadAttachment(file);
        setPendingAttachments((prev) =>
          prev.map((a) => (a.id === tempId ? { ...info, uploading: false, previewUrl } : a))
        );
      } catch (err) {
        console.error('Upload failed:', err);
        setPendingAttachments((prev) => prev.filter((a) => a.id !== tempId));
      }
    }
  };

  const removeAttachment = (id) => {
    setPendingAttachments((prev) => prev.filter((a) => a.id !== id));
  };

  const clearAttachments = () => setPendingAttachments([]);

  return {
    pendingAttachments,
    fileInputRef,
    openFilePicker,
    onFileSelect,
    removeAttachment,
    clearAttachments,
  };
}
