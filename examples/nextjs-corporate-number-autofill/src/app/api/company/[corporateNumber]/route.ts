import { NextResponse } from "next/server";

type BangoCompanyResponse = {
  data: {
    corporate_number: string;
    name: string;
    address: {
      post_code: string | null;
      prefecture: string | null;
      city: string | null;
      street: string | null;
    };
    invoice: {
      found: boolean;
      registration_number: string;
      registered: boolean;
      registration_date: string | null;
      cancel_date: string | null;
      expire_date: string | null;
      valid: boolean;
    } | null;
  };
};

type RouteContext = {
  params: Promise<{
    corporateNumber: string;
  }>;
};

export async function GET(
  _request: Request,
  { params }: RouteContext,
) {
  const { corporateNumber } = await params;

  if (!/^\d{13}$/.test(corporateNumber)) {
    return NextResponse.json(
      { error: "法人番号は13桁の数字で指定してください" },
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

  const response = await fetch(
    `https://api.bango-api.jp/v1/companies/${corporateNumber}`,
    {
      headers: {
        "x-api-key": apiKey,
      },
      cache: "no-store",
    },
  );

  if (response.status === 404) {
    return NextResponse.json(
      { error: "法人番号が見つかりませんでした" },
      { status: 404 },
    );
  }

  if (response.status === 429) {
    return NextResponse.json(
      { error: "APIの利用上限に達しました" },
      { status: 429 },
    );
  }

  if (!response.ok) {
    return NextResponse.json(
      { error: "会社情報の取得に失敗しました" },
      { status: 502 },
    );
  }

  const body = (await response.json()) as BangoCompanyResponse;
  const company = body.data;

  const invoiceStatus =
    !company.invoice ||
    !company.invoice.found ||
    !company.invoice.registered
      ? "未登録"
      : company.invoice.valid
        ? "有効"
        : "無効";

  return NextResponse.json({
    corporateNumber: company.corporate_number,
    companyName: company.name,
    postalCode: company.address.post_code ?? "",
    prefecture: company.address.prefecture ?? "",
    city: company.address.city ?? "",
    street: company.address.street ?? "",
    invoiceStatus,
  });
}