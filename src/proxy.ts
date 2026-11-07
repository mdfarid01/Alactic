import { NextResponse, type NextRequest } from "next/server";
import { embedAllowedOrigins, frameAncestorsHeader } from "@/server/public/embed-policy";

/**
 * 1. /dashboard: optimistic redirect when there's no session cookie (real authorization happens server-side).
 * 2. /embed/<slug>: Content-Security-Policy frame-ancestors from the agent's allowed sites, so browsers refuse to
 *    show the widget on sites the business didn't approve.
 */
export async function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;

  if (pathname.startsWith("/embed/")) {
    const slug = pathname.split("/")[2] ?? "";
    const response = NextResponse.next();
    response.headers.set("Content-Security-Policy", frameAncestorsHeader(await embedAllowedOrigins(slug)));
    return response;
  }

  const hasSession = request.cookies.has("__Host-alactic_session") || request.cookies.has("alactic_session");
  if (!hasSession) {
    const url = request.nextUrl.clone();
    url.pathname = "/sign-in";
    url.search = `?next=${encodeURIComponent(pathname)}`;
    return NextResponse.redirect(url);
  }
  return NextResponse.next();
}

export const config = {
  matcher: ["/dashboard/:path*", "/embed/:path*"],
};
