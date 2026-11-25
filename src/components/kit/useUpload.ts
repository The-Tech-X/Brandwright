"use client";

import { useCallback } from "react";
import { apiFetch } from "@/lib/api-client";
import { uploadProblem, type UploadPurpose } from "@/config/uploads";
import type { Upload } from "@/core/onboarding/schemas";
import { cleanReason } from "@/core/error-text";

/** Uploads a file straight to storage with a signed link. Returns its storage key. */
export function useUpload(purpose: UploadPurpose) {
  return useCallback(
    async (file: File): Promise<Upload> => {
      const problem = uploadProblem(purpose, file.type, file.size);
      if (problem) throw new Error(problem);

      const { id, key, url } = await apiFetch<{ id: string; key: string; url: string }>("/api/uploads", {
        method: "POST",
        body: JSON.stringify({ purpose, contentType: file.type, size: file.size }),
      });

      const what = `Storage (uploading ${file.name})`;
      // A browser gives no reason when it blocks a request, and CORS (a site address missing from the bucket's rules) is the usual cause
      const res = await fetch(url, { method: "PUT", body: file, headers: { "Content-Type": file.type } }).catch(() => {
        throw new Error(`${what} couldn't be reached from ${window.location.origin}: the browser blocked the request or the connection dropped. If this site address is new, add it to the R2 bucket's CORS rules.`);
      });
      if (!res.ok) {
        // R2 answers in S3's XML: <Code>…</Code><Message>…</Message>
        const body = await res.text().catch(() => "");
        const reason = body.match(/<Message>([^<]*)<\/Message>/)?.[1] ?? body;
        throw new Error(`${what} was refused (${res.status} ${res.statusText})${reason ? `: "${cleanReason(reason)}"` : ""}`);
      }

      return { id, key };
    },
    [purpose]
  );
}
