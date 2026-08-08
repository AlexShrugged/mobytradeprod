import { redirect } from "next/navigation";

// The review queue moved behind the super-admin seam. Old links survive.
export default function TariffReviewMoved() {
  redirect("/admin/tariffs");
}
