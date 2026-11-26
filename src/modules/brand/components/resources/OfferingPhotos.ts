"use client";

import { useMemo } from "react";
import { isVideoKey } from "@/components/kit/MediaUploader";
import type { Upload } from "@/core/onboarding/schemas";
import { useResource, useResourceMutations } from "../../hooks/useResource";

// A product's own photos, added in its form: brand_assets rows (kind product_photo) linked by offering_id, so
// the image and video makers send them with posts about it. The form keeps the photos as a list and saves the
// difference once the product is saved (a new product has no id until then).

/** The photos already linked to this product (none for a new one). Each item's id is its brand_assets row. */
export function useOfferingPhotos(offeringId: string | null) {
  const assets = useResource("assets");
  const linked = useMemo<Upload[]>(
    () =>
      offeringId
        ? (assets.data ?? [])
            .filter((a) => a.offering_id === offeringId && a.kind === "product_photo" && !isVideoKey(String(a.storage_key)))
            .map((a) => ({ id: String(a.id), key: String(a.storage_key) }))
        : [],
    [assets.data, offeringId]
  );
  return { linked, loading: !!offeringId && assets.isLoading };
}

/** Saves the form's photo list: new uploads become linked product photos; removed ones are unlinked, not deleted. */
export function useSaveOfferingPhotos() {
  const { create, update } = useResourceMutations("assets");
  return async (offeringId: string, before: Upload[], after: Upload[]) => {
    const had = new Set(before.map((p) => p.id));
    const kept = new Set(after.map((p) => p.id));
    for (const p of after) if (!had.has(p.id)) await create.mutateAsync({ storage_key: p.key, kind: "product_photo", offering_id: offeringId, tags: [] });
    // It stays in Photos and videos, as a photo of no product
    for (const p of before) if (!kept.has(p.id)) await update.mutateAsync({ id: p.id, values: { offering_id: null } });
  };
}
