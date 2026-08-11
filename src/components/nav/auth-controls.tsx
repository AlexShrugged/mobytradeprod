"use client";

import { OrganizationSwitcher, UserButton } from "@clerk/nextjs";

// Rendered into TopNav's authSlot only when Clerk is enabled. Both widgets
// render nothing while signed out, so the sign-in page's chrome stays clean.
export function AuthControls() {
  return (
    <>
      <OrganizationSwitcher
        hidePersonal
        afterSelectOrganizationUrl="/variance"
      />
      <UserButton />
    </>
  );
}
