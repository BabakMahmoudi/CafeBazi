export async function GET() {
  return Response.json({
    ok: true,
    service: "cafe-bazi",
    time: new Date().toISOString(),
  });
}
