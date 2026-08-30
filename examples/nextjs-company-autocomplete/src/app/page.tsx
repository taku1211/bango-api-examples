"use client";

import { useEffect, useState } from "react";
import { useForm, useWatch } from "react-hook-form";
import styles from "./page.module.css";

type CompanyCandidate = {
  corporateNumber: string;
  name: string;
  nameKana: string | null;
};

type CompanySearchResponse = {
  candidates: CompanyCandidate[];
};

type CompanyFormValues = {
  corporateNumber: string;
  companyName: string;
  postalCode: string;
  prefecture: string;
  city: string;
  street: string;
  invoiceStatus: string;
};

type CompanyLookupResponse = {
  corporateNumber: string;
  companyName: string;
  postalCode: string;
  prefecture: string;
  city: string;
  street: string;
  invoiceStatus: string;
};

type ErrorResponse = {
  error?: string;
};

export default function Home() {
  const {
    register,
    handleSubmit,
    setValue,
    control,
  } = useForm<CompanyFormValues>({
    defaultValues: {
      corporateNumber: "",
      companyName: "",
      postalCode: "",
      prefecture: "",
      city: "",
      street: "",
      invoiceStatus: "",
    },
  });

  const companyName = useWatch({
    control,
    name: "companyName",
    defaultValue: "",
  });

  const [candidates, setCandidates] = useState<CompanyCandidate[]>([]);
  const [selectedCompany, setSelectedCompany] =
    useState<CompanyCandidate | null>(null);

  const [isSearching, setIsSearching] = useState(false);
  const [hasSearched, setHasSearched] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);

  const [isLoading, setIsLoading] = useState(false);
  const [lookupError, setLookupError] = useState<string | null>(null);

  const clearCompanyDetails = () => {
    setValue("corporateNumber", "");
    setValue("postalCode", "");
    setValue("prefecture", "");
    setValue("city", "");
    setValue("street", "");
    setValue("invoiceStatus", "");
    setLookupError(null);
  };

  useEffect(() => {
    const query = companyName.trim();

    if (
      query.length < 2 ||
      selectedCompany?.name === query
    ) {
      return;
    }

    const controller = new AbortController();

    const timer = window.setTimeout(async () => {
      setIsSearching(true);
      setSearchError(null);

      try {
        const response = await fetch(
          `/api/companies/search?q=${encodeURIComponent(query)}`,
          {
            signal: controller.signal,
          },
        );

        if (!response.ok) {
          const error = (await response.json()) as ErrorResponse;

          throw new Error(
            error.error ?? "企業検索に失敗しました",
          );
        }

        const result =
          (await response.json()) as CompanySearchResponse;

        setCandidates(result.candidates);
        setHasSearched(true);
      } catch (error) {
        if (
          error instanceof DOMException &&
          error.name === "AbortError"
        ) {
          return;
        }

        setCandidates([]);

        setSearchError(
          error instanceof Error
            ? error.message
            : "企業検索に失敗しました",
        );
      } finally {
        if (!controller.signal.aborted) {
          setIsSearching(false);
        }
      }
    }, 400);

    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [companyName, selectedCompany]);

  const lookupCompany = async (corporateNumber: string) => {
    setIsLoading(true);
    setLookupError(null);

    try {
      const response = await fetch(
        `/api/company/${corporateNumber}`,
      );

      if (!response.ok) {
        const error = (await response.json()) as ErrorResponse;

        throw new Error(
          error.error ?? "会社情報の取得に失敗しました",
        );
      }

      const company =
        (await response.json()) as CompanyLookupResponse;

      setValue("corporateNumber", company.corporateNumber);
      setValue("companyName", company.companyName);
      setValue("postalCode", company.postalCode);
      setValue("prefecture", company.prefecture);
      setValue("city", company.city);
      setValue("street", company.street);
      setValue("invoiceStatus", company.invoiceStatus);
    } catch (error) {
      setLookupError(
        error instanceof Error
          ? error.message
          : "会社情報の取得に失敗しました",
      );
    } finally {
      setIsLoading(false);
    }
  };

  const handleSelectCandidate = async (
    candidate: CompanyCandidate,
  ) => {
    setSelectedCompany(candidate);
    setCandidates([]);
    setIsSearching(false);
    setHasSearched(false);
    setSearchError(null);

    clearCompanyDetails();

    setValue("companyName", candidate.name);
    setValue("corporateNumber", candidate.corporateNumber);

    await lookupCompany(candidate.corporateNumber);
  };

  const handleCompanyNameChange = () => {
    setSelectedCompany(null);
    setCandidates([]);
    setIsSearching(false);
    setHasSearched(false);
    setSearchError(null);

    clearCompanyDetails();
  };

  const onSubmit = (values: CompanyFormValues) => {
    console.log(values);
  };

  return (
    <main className={styles.main}>
      <section className={styles.card}>
        <div className={styles.heading}>
          <p className={styles.eyebrow}>法人登録</p>
          <h1>会社情報を入力</h1>
          <p>
            会社名を入力して候補を選ぶと、
            法人番号や住所を自動で取得できます。
          </p>
        </div>

        <form
          className={styles.form}
          onSubmit={handleSubmit(onSubmit)}
        >
          <div className={styles.field}>
            <label htmlFor="companyName">会社名</label>

            <div className={styles.autocomplete}>
              <input
                id="companyName"
                placeholder="例: トヨタ自動車"
                autoComplete="off"
                {...register("companyName", {
                  onChange: handleCompanyNameChange,
                })}
              />

              {isSearching && (
                <p className={styles.searchStatus}>
                  検索中...
                </p>
              )}

              {searchError && (
                <p className={styles.error}>
                  {searchError}
                </p>
              )}

              {!isSearching &&
                hasSearched &&
                candidates.length === 0 && (
                  <p className={styles.searchStatus}>
                    候補が見つかりませんでした
                  </p>
                )}

              {candidates.length > 0 && (
                <div className={styles.candidateList}>
                  {candidates.map((candidate) => (
                    <button
                      key={candidate.corporateNumber}
                      type="button"
                      className={styles.candidate}
                      onClick={() =>
                        handleSelectCandidate(candidate)
                      }
                    >
                      <span className={styles.candidateName}>
                        {candidate.name}
                      </span>

                      {candidate.nameKana && (
                        <span
                          className={styles.candidateKana}
                        >
                          {candidate.nameKana}
                        </span>
                      )}

                      <span
                        className={styles.candidateNumber}
                      >
                        法人番号 {candidate.corporateNumber}
                      </span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>

          <div className={styles.field}>
            <label htmlFor="corporateNumber">
              法人番号
            </label>
            <input
              id="corporateNumber"
              readOnly
              placeholder="企業を選択すると表示されます"
              {...register("corporateNumber")}
            />
          </div>

          {isLoading && (
            <p className={styles.searchStatus}>
              会社情報を取得中...
            </p>
          )}

          {lookupError && (
            <p className={styles.error}>
              {lookupError}
            </p>
          )}

          <div className={styles.field}>
            <label htmlFor="postalCode">郵便番号</label>
            <input
              id="postalCode"
              placeholder="1000001"
              {...register("postalCode")}
            />
          </div>

          <div className={styles.addressGrid}>
            <div className={styles.field}>
              <label htmlFor="prefecture">
                都道府県
              </label>
              <input
                id="prefecture"
                placeholder="東京都"
                {...register("prefecture")}
              />
            </div>

            <div className={styles.field}>
              <label htmlFor="city">市区町村</label>
              <input
                id="city"
                placeholder="千代田区"
                {...register("city")}
              />
            </div>
          </div>

          <div className={styles.field}>
            <label htmlFor="street">番地</label>
            <input
              id="street"
              placeholder="千代田1-1"
              {...register("street")}
            />
          </div>

          <div className={styles.field}>
            <label htmlFor="invoiceStatus">
              インボイス登録状況
            </label>
            <input
              id="invoiceStatus"
              readOnly
              placeholder="企業を選択すると表示されます"
              {...register("invoiceStatus")}
            />
          </div>

          <button
            type="submit"
            className={styles.submitButton}
            disabled={isLoading}
          >
            登録内容を確認
          </button>
        </form>
      </section>
    </main>
  );
}
