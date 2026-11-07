/** Earlier verification URLs (/v/<id>) now live at the full proof receipt (/proof/<id>): permanent redirect, so shared links keep working. */
export async function GET(request: Request, ctx: RouteContext<"/v/[inferenceId]">) {
  const { inferenceId } = await ctx.params;
  return Response.redirect(new URL(`/proof/${encodeURIComponent(inferenceId)}`, request.url), 308);
}
