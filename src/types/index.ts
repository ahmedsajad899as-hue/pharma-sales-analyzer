interface SalesData {
  id: string;
  drugName: string;
  quantity: number;
  price: number;
  date: string;
  region: string;
  salesRep: string;
  [key: string]: any;
}

export type { SalesData };