import { useState, useEffect, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import { toast } from 'react-toastify'
import { useTheme } from '../../contexts/ThemeContext'
import { useColors } from '../../hooks/useColors'
import { useConfig } from '../../hooks/useConfig'
import { buildUrl } from '../../utils/apiConfig'

export default function Auth() {
  const { colors, loading: colorsLoading } = useColors()
  const { config } = useConfig()
  
  const [isLogin, setIsLogin] = useState(true)
  const [formData, setFormData] = useState({
    fullname: '',
    password: '',
    confirmPassword: '',
    pin_code: '',
    terms: false
  })
  const [errors, setErrors] = useState({})
  const [isLoading, setIsLoading] = useState(false)
  const [message, setMessage] = useState('')
  const navigate = useNavigate()

  // Check if user is already logged in
  useEffect(() => {
    const token = localStorage.getItem('token')
    if (token) {
      navigate('/')
    }
  }, [navigate])

  const handleChange = useCallback((e) => {
    const { name, value, type, checked } = e.target
    setFormData(prev => ({
      ...prev,
      [name]: type === 'checkbox' ? checked : value
    }))
    // Clear error when user starts typing
    if (errors[name]) {
      setErrors(prev => ({
        ...prev,
        [name]: ''
      }))
    }
  }, [errors])

  const validateForm = useCallback(() => {
    const newErrors = {}

    if (!formData.fullname.trim()) {
      newErrors.fullname = 'กรุณากรอกชื่อผู้ใช้'
    }

    if (!formData.password) {
      newErrors.password = 'กรุณากรอกรหัสผ่าน'
    }

    if (!isLogin) {
      if (!formData.confirmPassword) {
        newErrors.confirmPassword = 'กรุณายืนยันรหัสผ่าน'
      } else if (formData.password !== formData.confirmPassword) {
        newErrors.confirmPassword = 'รหัสผ่านไม่ตรงกัน'
      }

      if (!formData.pin_code.trim()) {
        newErrors.pin_code = 'กรุณากรอกรหัส PIN'
      } else if (!/^\d{4,6}$/.test(formData.pin_code)) {
        newErrors.pin_code = 'รหัส PIN ต้องเป็นตัวเลข 4-6 หลัก'
      }

      if (!formData.terms) {
        newErrors.terms = 'กรุณายอมรับข้อกำหนดและเงื่อนไข'
      }
    }

    setErrors(newErrors)
    return Object.keys(newErrors).length === 0
  }, [formData, isLogin])

  const handleLogin = useCallback(async (e) => {
    e.preventDefault()
    
    if (!validateForm()) {
      return
    }

    setIsLoading(true)
    setMessage('')

    try {
      const response = await fetch(buildUrl('auth.login'), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          fullname: formData.fullname,
          password: formData.password
        })
      })

      const data = await response.json()

      if (response.ok) {
        localStorage.setItem('token', data.token)
        localStorage.setItem('userStatus', data.status || 'active')
        toast.success(data.message || 'เข้าสู่ระบบสำเร็จ!')
        navigate('/')
      } else {
        // Handle different status errors
        if (data.status === 'suspended') {
          toast.error('บัญชีถูกระงับ กรุณาติดต่อผู้ดูแลระบบ')
        } else if (data.status === 'customer_not_found') {
          toast.error('ไม่พบข้อมูลลูกค้า')
        } else {
          toast.error(data.error || data.message || 'เกิดข้อผิดพลาดในการเข้าสู่ระบบ')
        }
      }
    } catch (error) {
      console.error('Login error:', error)
      toast.error('เกิดข้อผิดพลาดในการเชื่อมต่อกับเซิร์ฟเวอร์')
    } finally {
      setIsLoading(false)
    }
  }, [formData, validateForm, navigate])

  const handleSignup = useCallback(async (e) => {
    e.preventDefault()
    
    if (!validateForm()) {
      return
    }

    setIsLoading(true)
    setMessage('')

    try {
      const response = await fetch(buildUrl('auth.register'), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          fullname: formData.fullname,
          password: formData.password,
          pin_code: formData.pin_code
        })
      })

      const data = await response.json()

      if (response.ok) {
        localStorage.setItem('token', data.token)
        localStorage.setItem('userStatus', data.status || 'active')
        toast.success(data.message || 'สมัครสมาชิกสำเร็จ!')
        navigate('/')
      } else {
        // Handle different status errors
        if (data.status === 'suspended') {
          toast.error('บัญชีถูกระงับ กรุณาติดต่อผู้ดูแลระบบ')
        } else if (data.status === 'customer_not_found') {
          toast.error('ไม่พบข้อมูลลูกค้า')
        } else {
          toast.error(data.error || data.message || 'เกิดข้อผิดพลาดในการสมัครสมาชิก')
        }
      }
    } catch (error) {
      console.error('Registration error:', error)
      toast.error('เกิดข้อผิดพลาดในการเชื่อมต่อกับเซิร์ฟเวอร์')
    } finally {
      setIsLoading(false)
    }
  }, [validateForm, formData, navigate])

  const toggleMode = () => {
    // Add fade out animation
    const formElement = document.querySelector('.auth-form-container')
    if (formElement) {
      formElement.style.animation = 'fadeOut 0.3s ease-out forwards'
      
      setTimeout(() => {
        setIsLogin(!isLogin)
        setFormData({ fullname: '', password: '', confirmPassword: '', pin_code: '', terms: false })
        setErrors({})
        setMessage('')
        
        // Reset all form elements animation
        setTimeout(() => {
          const formElements = document.querySelectorAll('.form-element-fade-in, .fade-up')
          formElements.forEach(element => {
            element.style.animation = 'none'
            element.style.opacity = '0'
            // Force reflow
            element.offsetHeight
            // Restart animation
            element.style.animation = ''
          })
          
          // Add fade in animation to container
          formElement.style.animation = 'fadeIn 0.3s ease-out forwards'
        }, 50)
      }, 300)
    } else {
      setIsLogin(!isLogin)
      setFormData({ fullname: '', password: '', confirmPassword: '', pin_code: '', terms: false })
      setErrors({})
      setMessage('')
    }
  }

  // Show loading while colors are being loaded
  if (colorsLoading || !colors) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-100">
        <div className="animate-spin rounded-full h-32 w-32 border-b-2 border-blue-600"></div>
      </div>
    )
  }

  return (
    <div className="relative min-h-screen">
      {/* Auth Form */}
      <div className="relative z-20 min-h-screen flex items-start justify-center pt-8 px-4 sm:px-6 lg:px-8">
        <div className="max-w-md w-full space-y-8">
          {/* Header */}
          <div className="text-center header-bounce">
            <h2 className={`text-3xl font-black ${colors.text.accent} mb-2`}>
              {config?.site_name || 'KIDDYXSTORE'}
            </h2>
            <p className={`${colors.text.muted} text-sm`}>
              {isLogin ? 'เข้าสู่ระบบ' : 'สมัครสมาชิก'}
            </p>
          </div>

          {/* Message Display */}
          {message && (
            <div className={`p-4 rounded-lg text-sm fade-up ${
              message.includes('สำเร็จ') 
                ? 'bg-green-500/20 text-green-300 border border-green-500/30' 
                : `${colors.status.error.bg} ${colors.status.error.text} ${colors.status.error.border} border`
            }`}>
              {message}
            </div>
          )}

          {/* Auth Form */}
          <form onSubmit={isLogin ? handleLogin : handleSignup} className="mt-8 space-y-6 fade-up">
            <div className="bg-white/10 backdrop-blur-md border border-white/20 rounded-2xl p-6 bubble-expand shadow-2xl auth-form-container">
              <div className="space-y-6">
                {/* Full Name Input */}
                <div className="form-element-fade-in fade-up" style={{ animationDelay: '0.3s' }}>
                  <label htmlFor="fullname" className={`block text-sm font-medium ${colors.text.primary} mb-2 fade-up`} style={{ animationDelay: '0.4s' }}>
                    ชื่อผู้ใช้
                  </label>
                  <input
                    id="fullname"
                    name="fullname"
                    type="text"
                    value={formData.fullname}
                    onChange={handleChange}
                    required
                    className={`w-full px-3 py-2 bg-white/20 backdrop-blur-sm border ${
                      errors.fullname ? 'border-red-400' : 'border-white/30'
                    } rounded-lg ${colors.text.primary} ${colors.text.muted} focus:outline-none focus:ring-2 focus:ring-white/50 focus:border-white/50 transition-all duration-300 text-sm fade-up`}
                    style={{ animationDelay: '0.5s' }}
                    placeholder="กรอกชื่อผู้ใช้ของคุณ"
                  />
                  {errors.fullname && (
                    <p className={`mt-1 text-sm text-red-400 fade-up`} style={{ animationDelay: '0.6s' }}>{errors.fullname}</p>
                  )}
                </div>

                {/* Password Input */}
                <div className="form-element-fade-in fade-up" style={{ animationDelay: '0.5s' }}>
                  <label htmlFor="password" className={`block text-sm font-medium ${colors.text.primary} mb-2 fade-up`} style={{ animationDelay: '0.6s' }}>
                    รหัสผ่าน
                  </label>
                  <input
                    id="password"
                    name="password"
                    type="password"
                    value={formData.password}
                    onChange={handleChange}
                    required
                    className={`w-full px-3 py-2 bg-white/20 backdrop-blur-sm border ${
                      errors.password ? 'border-red-400' : 'border-white/30'
                    } rounded-lg ${colors.text.primary} ${colors.text.muted} focus:outline-none focus:ring-2 focus:ring-white/50 focus:border-white/50 transition-all duration-300 text-sm fade-up`}
                    style={{ animationDelay: '0.7s' }}
                    placeholder="กรอกรหัสผ่านของคุณ"
                  />
                  {errors.password && (
                    <p className={`mt-1 text-sm text-red-400 fade-up`} style={{ animationDelay: '0.8s' }}>{errors.password}</p>
                  )}
                </div>

                {/* Confirm Password Input (only for signup) */}
                {!isLogin && (
                  <div className="form-element-fade-in fade-up" style={{ animationDelay: '0.7s' }}>
                    <label htmlFor="confirmPassword" className={`block text-sm font-medium ${colors.text.primary} mb-2 fade-up`} style={{ animationDelay: '0.8s' }}>
                      ยืนยันรหัสผ่าน
                    </label>
                    <input
                      id="confirmPassword"
                      name="confirmPassword"
                      type="password"
                      value={formData.confirmPassword}
                      onChange={handleChange}
                      required={!isLogin}
                      className={`w-full px-3 py-2 bg-white/20 backdrop-blur-sm border ${
                        errors.confirmPassword ? 'border-red-400' : 'border-white/30'
                      } rounded-lg ${colors.text.primary} ${colors.text.muted} focus:outline-none focus:ring-2 focus:ring-white/50 focus:border-white/50 transition-all duration-300 text-sm fade-up`}
                      style={{ animationDelay: '0.9s' }}
                      placeholder="ยืนยันรหัสผ่านของคุณ"
                    />
                    {errors.confirmPassword && (
                      <p className={`mt-1 text-sm text-red-400 fade-up`} style={{ animationDelay: '1.0s' }}>{errors.confirmPassword}</p>
                    )}
                  </div>
                )}

                {/* PIN Code Input (only for signup) */}
                {!isLogin && (
                  <div className="form-element-fade-in fade-up" style={{ animationDelay: '0.9s' }}>
                    <label htmlFor="pin_code" className={`block text-sm font-medium ${colors.text.primary} mb-2 fade-up`} style={{ animationDelay: '1.0s' }}>
                      รหัส PIN
                    </label>
                    <input
                      id="pin_code"
                      name="pin_code"
                      type="password"
                      value={formData.pin_code}
                      onChange={handleChange}
                      required={!isLogin}
                      className={`w-full px-3 py-2 bg-white/20 backdrop-blur-sm border ${
                        errors.pin_code ? 'border-red-400' : 'border-white/30'
                      } rounded-lg ${colors.text.primary} ${colors.text.muted} focus:outline-none focus:ring-2 focus:ring-white/50 focus:border-white/50 transition-all duration-300 text-sm fade-up`}
                      style={{ animationDelay: '1.1s' }}
                      placeholder="กรอกรหัส PIN 4-6 หลัก"
                      maxLength="6"
                    />
                    {errors.pin_code && (
                      <p className={`mt-1 text-sm text-red-400 fade-up`} style={{ animationDelay: '1.2s' }}>{errors.pin_code}</p>
                    )}
                  </div>
                )}

                {/* Remember Me & Forgot Password (only for login) */}
                {isLogin && (
                  <div className="flex items-center justify-between form-element-fade-in" style={{ animationDelay: '0.7s' }}>
                    <div className="flex items-center">
                      <input
                        id="remember-me"
                        name="remember-me"
                        type="checkbox"
                        className={`h-4 w-4 ${colors.text.accent} ${colors.border.focusRing} border-gray-300 rounded`}
                      />
                      <label htmlFor="remember-me" className={`ml-2 block text-sm ${colors.text.muted}`}>
                        จดจำการเข้าสู่ระบบ
                      </label>
                    </div>
                    <div className="text-sm">
                      <a href="#" className={`font-medium ${colors.text.primary} hover:${colors.text.muted} transition-colors`}>
                        ลืมรหัสผ่าน?
                      </a>
                    </div>
                  </div>
                )}

                {/* Terms and Conditions (only for signup) */}
                {!isLogin && (
                  <div className="flex items-start form-element-fade-in" style={{ animationDelay: '1.3s' }}>
                    <div className="flex items-center h-5">
                      <input
                        id="terms"
                        name="terms"
                        type="checkbox"
                        checked={formData.terms}
                        onChange={handleChange}
                        required={!isLogin}
                        className={`h-4 w-4 ${colors.text.accent} ${colors.border.focusRing} border-gray-300 rounded fade-up`}
                        style={{ animationDelay: '1.4s' }}
                      />
                    </div>
                    <div className="ml-3 text-xs">
                      <label htmlFor="terms" className={`${colors.text.muted} fade-up`} style={{ animationDelay: '1.5s' }}>
                        ฉันยอมรับ{' '}
                        <a href="#" className={`font-medium ${colors.text.primary} hover:${colors.text.muted} transition-colors`}>
                          ข้อกำหนดและเงื่อนไข
                        </a>
                      </label>
                      {errors.terms && (
                        <p className={`mt-1 text-sm text-red-400 fade-up`} style={{ animationDelay: '1.6s' }}>{errors.terms}</p>
                      )}
                    </div>
                  </div>
                )}

                {/* Submit Button */}
                <div className="form-element-fade-in" style={{ animationDelay: isLogin ? '0.9s' : '1.7s' }}>
                  <button
                    type="submit"
                    disabled={isLoading}
                    className={`group relative w-full flex justify-center py-2 px-3 border border-transparent text-xs font-medium rounded-lg text-white bg-gradient-to-r from-blue-500 to-blue-600 hover:from-blue-600 hover:to-blue-700 focus:outline-none focus:ring-2 focus:ring-white/50 transition-all duration-300 transform hover:scale-105 shadow-lg hover:shadow-xl ${isLoading ? 'opacity-50 cursor-not-allowed' : ''}`}
                  >
                    <span className="absolute left-0 inset-y-0 flex items-center pl-3">
                      {isLoading ? (
                        <svg className={`animate-spin h-5 w-5 text-white`} fill="none" viewBox="0 0 24 24">
                          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                          <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                        </svg>
                      ) : (
                        <svg className={`h-5 w-5 text-white group-hover:text-white/90`} fill="currentColor" viewBox="0 0 20 20">
                          <path fillRule="evenodd" d="M5 9V7a5 5 0 0110 0v2a2 2 0 012 2v5a2 2 0 01-2 2H5a2 2 0 01-2-2v-5a2 2 0 012-2zm8-2v2H7V7a3 3 0 016 0z" clipRule="evenodd" />
                        </svg>
                      )}
                    </span>
                    {isLoading ? (isLogin ? 'กำลังเข้าสู่ระบบ...' : 'กำลังสมัครสมาชิก...') : (isLogin ? 'เข้าสู่ระบบ' : 'สมัครสมาชิก')}
                  </button>
                </div>


                {/* Toggle Link */}
                <div className="text-center form-element-fade-in" style={{ animationDelay: isLogin ? '1.1s' : '1.7s' }}>
                  <p className={colors.text.muted}>
                    {isLogin ? 'ยังไม่มีบัญชี?' : 'มีบัญชีแล้ว?'}{' '}
                    <button
                      type="button"
                      onClick={toggleMode}
                      className={`font-medium ${colors.text.primary} hover:${colors.text.muted} transition-colors`}
                    >
                      {isLogin ? 'สมัครสมาชิก' : 'เข้าสู่ระบบ'}
                    </button>
                  </p>
                </div>
              </div>
            </div>
          </form>
        </div>
      </div>

      {/* CSS Styles */}
      <style>{`
        :root {
          --toast-success-bg: ${colors.background.primary || 'rgba(16, 185, 129, 0.95)'};
          --toast-success-border: #10b981;
          --toast-success-text: ${colors.text.primary || '#ffffff'};
          --toast-error-bg: ${colors.background.primary || 'rgba(239, 68, 68, 0.95)'};
          --toast-error-border: #ef4444;
          --toast-error-text: ${colors.text.primary || '#ffffff'};
          --toast-warning-bg: ${colors.background.primary || 'rgba(245, 158, 11, 0.95)'};
          --toast-warning-border: #f59e0b;
          --toast-warning-text: ${colors.text.primary || '#ffffff'};
          --toast-info-bg: ${colors.background.primary || 'rgba(59, 130, 246, 0.95)'};
          --toast-info-border: #3b82f6;
          --toast-info-text: ${colors.text.primary || '#ffffff'};
          --toast-text-color: ${colors.text.primary || '#ffffff'};
        }
        @keyframes bubble-expand {
          0% {
            transform: scale(0.3) translateY(50px);
            opacity: 0;
            border-radius: 50%;
          }
          50% {
            transform: scale(0.8) translateY(-10px);
            opacity: 0.8;
            border-radius: 30px;
          }
          100% {
            transform: scale(1) translateY(0);
            opacity: 1;
            border-radius: 16px;
          }
        }
        
        .bubble-expand {
          animation: bubble-expand 1.2s cubic-bezier(0.34, 1.56, 0.64, 1) forwards;
          transform-origin: center center;
          will-change: transform, opacity;
        }
        
        @keyframes form-element-fade-in {
          0% {
            opacity: 0;
            transform: translateY(20px) scale(0.95);
          }
          100% {
            opacity: 1;
            transform: translateY(0) scale(1);
          }
        }
        
        .form-element-fade-in {
          animation: form-element-fade-in 0.6s cubic-bezier(0.25, 0.46, 0.45, 0.94) forwards;
          opacity: 0;
          will-change: transform, opacity;
        }
        
        @keyframes header-bounce {
          0% {
            opacity: 0;
            transform: translateY(-30px) scale(0.9);
          }
          60% {
            transform: translateY(5px) scale(1.02);
          }
          100% {
            opacity: 1;
            transform: translateY(0) scale(1);
          }
        }
        
        .header-bounce {
          animation: header-bounce 1s cubic-bezier(0.68, -0.55, 0.265, 1.55) forwards;
          opacity: 0;
          will-change: transform, opacity;
        }
        
        @keyframes fade-up {
          0% {
            opacity: 0;
            transform: translateY(30px);
          }
          100% {
            opacity: 1;
            transform: translateY(0);
          }
        }
        
        .fade-up {
          animation: fade-up 0.8s ease-out forwards;
          opacity: 0;
          will-change: transform, opacity;
        }
        
        @keyframes fadeOut {
          0% {
            opacity: 1;
            transform: scale(1) translateY(0);
          }
          100% {
            opacity: 0;
            transform: scale(0.95) translateY(-10px);
          }
        }
        
        @keyframes fadeIn {
          0% {
            opacity: 0;
            transform: scale(0.95) translateY(10px);
          }
          100% {
            opacity: 1;
            transform: scale(1) translateY(0);
          }
        }
        
        .auth-form-container {
          transition: all 0.3s ease-out;
        }
      `}</style>
    </div>
  )
}
