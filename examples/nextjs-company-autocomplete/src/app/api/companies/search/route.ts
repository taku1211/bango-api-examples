import { NextResponse } from "next/server";

type BangoCompanySearchResponse = {
  data: Array<{
    corporate_number: string;
    name: string;
    name_kana: string | null;
    prefecture_code: string | null;
    city_code: string | null;
    score: number;
  }>;
};

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const query = searchParams.get("q")?.trim() ?? "";

  if (query.length < 2) {
    return NextResponse.json(
      { error: "会社名は2文字以上入力してください" },
      { status: 400 },
    );
  }

  const apiKey = process.env.BANGO_API_KEY;

  if (!apiKey) {
    return NextResponse.json(
      { error: "BANGO_API_KEY is not configured" },
      { status: 500 },
    );
  }

  const url = new URL(
    "https://api.bango-api.jp/v1/companies/search",
  );

  url.searchParams.set("q", query);
  url.searchParams.set("mode", "partial");
  url.searchParams.set("limit", "10");

  const response = await fetch(url, {
    headers: {
      "x-api-key": apiKey,
    },
    cache: "no-store",
  });

  if (response.status === 429) {
    return NextResponse.json(
      { error: "APIの利用上限に達しました" },
      { status: 429 },
    );
  }

  if (!response.ok) {
    return NextResponse.json(
      { error: "企業検索に失敗しました" },
      { status: 502 },
    );
  }

  const body =
    (await response.json()) as BangoCompanySearchResponse;

  return NextResponse.json({
    candidates: body.data.map((company) => ({
      corporateNumber: company.corporate_number,
      name: company.name,
      nameKana: company.name_kana,
    })),
  });
}
