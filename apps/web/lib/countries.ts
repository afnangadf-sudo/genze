// Country options for signup. Pakistan first, then other common countries.
// Values are ISO-3166-1 alpha-2 uppercase, as the API expects.

export interface CountryOption {
  code: string;
  name: string;
}

export const COUNTRIES: CountryOption[] = [
  { code: "PK", name: "Pakistan" },
  { code: "US", name: "United States" },
  { code: "GB", name: "United Kingdom" },
  { code: "CA", name: "Canada" },
  { code: "AU", name: "Australia" },
  { code: "AE", name: "United Arab Emirates" },
  { code: "SA", name: "Saudi Arabia" },
  { code: "QA", name: "Qatar" },
  { code: "KW", name: "Kuwait" },
  { code: "BH", name: "Bahrain" },
  { code: "OM", name: "Oman" },
  { code: "AF", name: "Afghanistan" },
  { code: "IN", name: "India" },
  { code: "BD", name: "Bangladesh" },
  { code: "LK", name: "Sri Lanka" },
  { code: "NP", name: "Nepal" },
  { code: "IR", name: "Iran" },
  { code: "TR", name: "Turkey" },
  { code: "MY", name: "Malaysia" },
  { code: "ID", name: "Indonesia" },
  { code: "DE", name: "Germany" },
  { code: "FR", name: "France" },
  { code: "NL", name: "Netherlands" },
  { code: "IT", name: "Italy" },
  { code: "ES", name: "Spain" },
  { code: "SE", name: "Sweden" },
  { code: "NO", name: "Norway" },
  { code: "CH", name: "Switzerland" },
  { code: "NZ", name: "New Zealand" },
  { code: "SG", name: "Singapore" },
  { code: "ZA", name: "South Africa" },
  { code: "NG", name: "Nigeria" },
  { code: "EG", name: "Egypt" },
  { code: "PS", name: "Palestine" },
  { code: "JP", name: "Japan" },
  { code: "KR", name: "South Korea" },
  { code: "CN", name: "China" },
  { code: "BR", name: "Brazil" },
  { code: "MX", name: "Mexico" },
];
