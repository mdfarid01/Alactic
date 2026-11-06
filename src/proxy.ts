import { NextResponse, type NextRequest } from "next/server";

/**
 * Optimistic check only: send visitors without a session cookie to sign-in.
 * Real authorization happens server-side on every page and action (DAL + authorizeOrg).
 */
export function proxy(request: NextRequest) {
  const hasSession =
    request.cookies.has("__Host-alactic_session") || request.cookies.has("alactic_session");
  if (!hasSession) {
    const url = request.nextUrl.clone();
    url.pathname = "/sign-in";
    url.search = `?next=${encodeURIComponent(request.nextUrl.pathname)}`;
    return NextResponse.redirect(url);
  }
  return NextResponse.next();
}

export const config = {
  matcher: ["/dashboard/:path*"],
};
