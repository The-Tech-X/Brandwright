import sharp from "sharp";

// Places the brand's real logo file on a finished image ad. Image models redraw a logo they are shown (wrong
// letters, a box painted behind it), so the model is told to leave the top corners clear and our code puts the
// logo there: no box, at its own proportions, in whichever top corner is calmer, and in the version that reads on
// that corner (the white "on dark" one on a dark corner, the normal one on a light corner).

export interface LogoFiles {
  /** The normal logo, for light backgrounds */
  light: Buffer | null;
  /** The white version, for dark backgrounds */
  dark: Buffer | null;
}

/** The logo's width as a share of the ad's width, and the gap to the edges */
const LOGO_WIDTH = 0.2;
const LOGO_MAX_HEIGHT = 0.09;
const MARGIN = 0.045;

/** How busy and how bright one area of the picture is (0–255) */
async function look(image: Buffer, box: { left: number; top: number; width: number; height: number }) {
  // stats() reads the whole input, not the crop, so the crop is made into its own image first
  const area = await sharp(image).extract(box).removeAlpha().png().toBuffer();
  const { channels } = await sharp(area).stats();
  const [r, g, b] = channels;
  return { busy: (r.stdev + g.stdev + b.stdev) / 3, bright: 0.2126 * r.mean + 0.7152 * g.mean + 0.0722 * b.mean };
}

export async function placeLogo(ad: Buffer, logos: LogoFiles): Promise<Buffer> {
  if (!logos.light && !logos.dark) return ad;
  const { width = 1, height = 1 } = await sharp(ad).metadata();
  const margin = Math.round(width * MARGIN);
  const boxWidth = Math.round(width * LOGO_WIDTH);
  const boxHeight = Math.round(height * LOGO_MAX_HEIGHT);

  // The calmer of the two top corners (words or the subject there make it busy)
  const corners = await Promise.all(
    (["left", "right"] as const).map(async (side) => {
      const left = side === "left" ? margin : width - margin - boxWidth;
      return { side, left, ...(await look(ad, { left, top: margin, width: boxWidth, height: boxHeight })) };
    })
  );
  const corner = corners[0].busy <= corners[1].busy ? corners[0] : corners[1];

  // White logo on a dark corner, the normal one on a light corner; whichever exists when only one does
  const file = corner.bright < 140 ? (logos.dark ?? logos.light)! : (logos.light ?? logos.dark)!;
  const logo = await sharp(file).resize(boxWidth, boxHeight, { fit: "inside" }).png().toBuffer();
  const { width: w = boxWidth } = await sharp(logo).metadata();
  const left = corner.side === "left" ? margin : width - margin - w;

  return sharp(ad).composite([{ input: logo, left, top: margin }]).png().toBuffer();
}
