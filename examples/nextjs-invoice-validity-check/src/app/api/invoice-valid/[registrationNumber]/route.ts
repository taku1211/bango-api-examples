import { NextResponse } from "next/server";

type BangoInvoiceValidityResponse = {
  data: {
    registration_number: string;
    date: string;
    valid: boolean;
    registration_date: string | null;
    cancel_date: string | null;
    expire_date: string | null;
  };
};

type BangoProblem = {
  code?: string;
  limit_scope?: string | null;
  retry_after?: number | null;
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
        code: "VALIDATION_ERROR",
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
        code: "CONFIGURATION_ERROR",
        error: "BANGO_API_KEY is not configured",
      },
      {
        status: 500,
      },
    );
  }

  let response: Response;

  try {
    response = await fetch(
      `https://api.bango-api.jp/v1/invoice/${encodeURIComponent(
        registrationNumber,
      )}/valid`,
      {
        headers: {
          "x-api-key": apiKey,
        },
        cache: "no-store",
      },
    );
  } catch {
    return NextResponse.json(
      {
        code: "UPSTREAM_ERROR",
        error: "インボイス登録状況を現在確認できません",
      },
      {
        status: 502,
      },
    );
  }

  if (response.status === 404) {
    return NextResponse.json(
      {
        code: "NOT_FOUND",
        error: "登録番号が見つかりませんでした",
      },
      {
        status: 404,
      },
    );
  }

  if (response.status === 429) {
    const problem = (await response
      .json()
      .catch(() => null)) as BangoProblem | null;

    if (problem?.code === "QUOTA_EXCEEDED") {
      return NextResponse.json(
        {
          code: "QUOTA_EXCEEDED",
          error: "今月のAPI利用上限に達しました",
          retryAfter: problem.retry_after ?? null,
        },
        {
          status: 429,
        },
      );
    }

    return NextResponse.json(
      {
        code: "RATE_LIMIT_EXCEEDED",
        error:
          "APIのレート制限に達しました。しばらくして再試行してください",
        retryAfter: problem?.retry_after ?? null,
      },
      {
        status: 429,
      },
    );
  }

  if (response.status === 503) {
    return NextResponse.json(
      {
        code: "DEPENDENCY_UNAVAILABLE",
        error: "インボイス登録状況を現在確認できません",
      },
      {
        status: 503,
      },
    );
  }

  if (!response.ok) {
    return NextResponse.json(
      {
        code: "UPSTREAM_ERROR",
        error: "インボイス登録状況の確認に失敗しました",
      },
      {
        status: 502,
      },
    );
  }

  const body =
    (await response.json()) as BangoInvoiceValidityResponse;

  return NextResponse.json({
    registrationNumber: body.data.registration_number,
    date: body.data.date,
    valid: body.data.valid,
    registrationDate: body.data.registration_date,
    cancelDate: body.data.cancel_date,
    expireDate: body.data.expire_date,
  });
}
