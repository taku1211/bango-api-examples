import { NextResponse } from "next/server";

type BangoInvoiceLookupResponse = {
  data: {
    kind: "corporation" | "individual";
    corporate_number: string | null;
    name: string | null;
    address: {
      post_code: string | null;
      full: string | null;
    } | null;
    invoice: {
      registration_number: string | null;
      registration_date: string | null;
      valid: boolean;
    };
  };
};

type RouteContext = {
  params: Promise<{
    registrationNumber: string;
  }>;
};

export async function GET(_request: Request, { params }: RouteContext) {
  const { registrationNumber } = await params;

  if (!/^T\d{13}$/.test(registrationNumber)) {
    return NextResponse.json(
      {
        error: "T番号はT + 13桁の数字で入力してください",
      },
      {
        status: 400,
      },
    );
  }

  const apiKey = process.env.BANGO_API_KEY;

  if (!apiKey) {
    return NextResponse.json(
      {
        error: "BANGO_API_KEY is not configured",
      },
      {
        status: 500,
      },
    );
  }

  const response = await fetch(
    `https://api.bango-api.jp/v1/invoice/${registrationNumber}`,
    {
      headers: {
        "x-api-key": apiKey,
      },
      cache: "no-store",
    },
  );

  if (response.status === 404) {
    return NextResponse.json(
      {
        error: "登録番号が見つかりませんでした",
      },
      {
        status: 404,
      },
    );
  }

  if (response.status === 429) {
    return NextResponse.json(
      {
        error: "APIの利用上限に達しました",
      },
      {
        status: 429,
      },
    );
  }

  if (!response.ok) {
    return NextResponse.json(
      {
        error: "事業者情報の取得に失敗しました",
      },
      {
        status: 502,
      },
    );
  }

  const body = (await response.json()) as BangoInvoiceLookupResponse;
  const issuer = body.data;

  return NextResponse.json({
    kind: issuer.kind,
    registrationNumber: issuer.invoice.registration_number ?? registrationNumber,
    registrationDate: issuer.invoice.registration_date,
    valid: issuer.invoice.valid,
    corporateNumber: issuer.corporate_number,
    name: issuer.name,
    postalCode: issuer.address?.post_code ?? null,
    address: issuer.address?.full ?? null,
  });
}
