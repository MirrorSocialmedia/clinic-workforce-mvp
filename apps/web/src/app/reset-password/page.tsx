import Link from 'next/link'

// ★ cwm-p0sec-20260917：自助重設已停用 —— 頁面只提示聯絡負責人（舊表單會攞 reset token，知電話即可接管帳號）
export default function ResetPasswordPage() {
  return (
    <div className="login-container">
      <div className="login-card">
        <h1>🔑 重置密碼</h1>
        <p>自助重設密碼已停用，請聯絡診所負責人重設密碼。</p>
        <Link
          href="/login"
          className="btn btn-primary"
          style={{ width: '100%', justifyContent: 'center', padding: '12px', marginTop: 20, display: 'flex' }}
        >
          返回登入
        </Link>
      </div>
    </div>
  )
}
