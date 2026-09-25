import logoUrl from '../assets/logo.png'

interface BrandMarkProps {
  /** auth: 认证卡片顶部的大徽标;sidebar: 深色侧栏的紧凑形态(徽标 + 平台名);header: 顶栏浅色形态。 */
  variant: 'auth' | 'sidebar' | 'header'
}

/** 平台品牌标识:云汉企业AI协同平台 logo 徽标(两种形态共用一份品牌资产)。 */
export function BrandMark({ variant }: BrandMarkProps) {
  if (variant === 'sidebar') {
    return (
      <div className="dsh-brand">
        <span className="dsh-brand-logo">
          <img src={logoUrl} alt="云汉企业AI协同平台" />
        </span>
        <span className="dsh-brand-name">云汉企业AI协同平台</span>
      </div>
    )
  }
  if (variant === 'header') {
    return (
      <div className="dsh-header-brand">
        <img src={logoUrl} alt="" aria-hidden="true" />
        <span>云汉企业AI协同平台</span>
      </div>
    )
  }
  return (
    <div className="auth-brand">
      <img src={logoUrl} alt="云汉企业AI协同平台" />
    </div>
  )
}
