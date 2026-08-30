"use client";

import { useState } from "react";
import { useForm } from "react-hook-form";
import styles from "./page.module.css";

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
    getValues,
    setValue,
    trigger,
    formState: { errors },
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

  const [isLoading, setIsLoading] = useState(false);
  const [lookupError, setLookupError] = useState<string | null>(null);

  const handleLookupCompany = async () => {
    const isValid = await trigger("corporateNumber");

    if (!isValid) {
      return;
    }

    const corporateNumber = getValues("corporateNumber");

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

  const clearCompanyFields = () => {
    setValue("companyName", "");
    setValue("postalCode", "");
    setValue("prefecture", "");
    setValue("city", "");
    setValue("street", "");
    setValue("invoiceStatus", "");
    setLookupError(null);
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
            法人番号を入力すると、会社名や住所を自動で取得できます。
          </p>
        </div>

        <form className={styles.form} onSubmit={handleSubmit(onSubmit)}>
          <div className={styles.field}>
            <label htmlFor="corporateNumber">法人番号</label>

            <div className={styles.lookupRow}>
              <input
                id="corporateNumber"
                inputMode="numeric"
                maxLength={13}
                placeholder="例: 1180301018771"
                {...register("corporateNumber", {
                  required: "法人番号を入力してください",
                  pattern: {
                    value: /^\d{13}$/,
                    message: "法人番号は13桁の数字で入力してください",
                  },
                  onChange: clearCompanyFields,
                })}
              />

              <button
                type="button"
                className={styles.lookupButton}
                onClick={handleLookupCompany}
                disabled={isLoading}
              >
                {isLoading ? "取得中..." : "会社情報を取得"}
              </button>
            </div>

            {errors.corporateNumber && (
              <p className={styles.error}>
                {errors.corporateNumber.message}
              </p>
            )}

            {lookupError && (
              <p className={styles.error}>{lookupError}</p>
            )}
          </div>

          <div className={styles.field}>
            <label htmlFor="companyName">会社名</label>
            <input
              id="companyName"
              placeholder="株式会社〇〇"
              {...register("companyName")}
            />
          </div>

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
              <label htmlFor="prefecture">都道府県</label>
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
            <label htmlFor="invoiceStatus">インボイス登録状況</label>
            <input
              id="invoiceStatus"
              readOnly
              placeholder="会社情報を取得すると表示されます"
              {...register("invoiceStatus")}
            />
          </div>

          <button type="submit" className={styles.submitButton}>
            登録内容を確認
          </button>
        </form>
      </section>
    </main>
  );
}
