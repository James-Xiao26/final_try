import { NextResponse } from "next/server";
import { isValidAddress } from "@/lib/format";
import { getWalletProfile } from "@/lib/supabase";

interface WalletRouteProps {
  params: {
    address: string;
  };
}

export async function GET(_request: Request, { params }: WalletRouteProps) {
  const address = params.address.toLowerCase();

  if (!isValidAddress(address)) {
    return NextResponse.json({ error: "Invalid wallet address" }, { status: 400 });
  }

  try {
    const profile = await getWalletProfile(address);

    if (!profile) {
      return NextResponse.json(null, { status: 404 });
    }

    return NextResponse.json(profile, {
      headers: {
        "Cache-Control": "s-maxage=3600, stale-while-revalidate=300"
      }
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to load wallet" },
      { status: 500 }
    );
  }
}
