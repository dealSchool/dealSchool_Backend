const FONT = "'Plus Jakarta Sans',-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif";

export default function Home() {
  return (
    <main
      style={{
        minHeight: "100vh",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: "#ECEAE3",
        fontFamily: FONT,
        padding: "24px",
      }}
    >
      <div
        style={{
          maxWidth: 480,
          width: "100%",
          background: "#ffffff",
          borderRadius: 12,
          overflow: "hidden",
          boxShadow: "0 4px 32px rgba(8,44,108,.13)",
        }}
      >
        <div style={{ background: "#082C6C", padding: "28px 32px 20px" }}>
          <p
            style={{
              margin: 0,
              fontFamily: FONT,
              fontSize: 20,
              fontWeight: 700,
              letterSpacing: 2.5,
              color: "#ffffff",
              textTransform: "uppercase",
            }}
          >
            Deal<span style={{ color: "#D4A62A" }}>School</span>
          </p>
        </div>
        <div style={{ height: 3, background: "linear-gradient(90deg,#B8891A,#D4A62A 40%,#F0C040 70%,#D4A62A)" }} />

        <div style={{ padding: "32px" }}>
          <h1 style={{ margin: "0 0 12px", fontSize: 22, fontWeight: 700, color: "#082C6C" }}>DealSchool API</h1>
          <p style={{ margin: 0, fontSize: 15, lineHeight: 1.7, color: "#374151" }}>
            This is the DealSchool backend service. There&apos;s nothing to see here directly — head to the main site instead.
          </p>
        </div>
      </div>
    </main>
  );
}
