# Multi-Tenant System Testing Guide

## Overview
ระบบ Multi-Tenant ที่ใช้ subdomain เป็นตัวระบุลูกค้า โดยแต่ละ subdomain จะมีข้อมูลแยกกัน

## การตั้งค่า

### 1. Database Setup
รันไฟล์ `MSA.sql` เพื่อสร้างตารางและข้อมูลตัวอย่าง

### 2. Server Configuration
แก้ไข domain ใน middleware:
```javascript
// ใน server.mjs บรรทัด 45
if (host.includes('localhost') || host === 'yourdomain.com' || !subdomain || subdomain === 'www') {
```

เปลี่ยน `yourdomain.com` เป็น domain จริงของคุณ

## การทดสอบ

### 1. Local Testing
ใช้ hosts file หรือ local DNS:
```
127.0.0.1 demo.localhost
127.0.0.1 test.localhost
```

หรือทดสอบด้วย localhost โดยตรง (จะใช้ website_name = 'death' อัตโนมัติ):
```
http://localhost:3000
```

### 2. API Testing

#### Test 1: ตรวจสอบ subdomain detection
```bash
# Test with localhost (ใช้ death อัตโนมัติ)
curl http://localhost:3000/

# Test with demo subdomain
curl -H "Host: demo.localhost:3000" http://localhost:3000/

# Test with test subdomain  
curl -H "Host: test.localhost:3000" http://localhost:3000/

# Test with invalid subdomain
curl -H "Host: invalid.localhost:3000" http://localhost:3000/
```

#### Test 2: ตรวจสอบ customer isolation
```bash
# Get categories for localhost (death customer)
curl http://localhost:3000/categories

# Get categories for demo customer
curl -H "Host: demo.localhost:3000" http://localhost:3000/categories

# Get categories for test customer
curl -H "Host: test.localhost:3000" http://localhost:3000/categories
```

#### Test 3: ตรวจสอบ authentication
```bash
# Signup for localhost (death customer)
curl -X POST -H "Content-Type: application/json" \
  -d '{"fullname":"Test User","email":"test@death.com","password":"password123"}' \
  http://localhost:3000/signup

# Login for localhost (death customer)
curl -X POST -H "Content-Type: application/json" \
  -d '{"email":"test@death.com","password":"password123"}' \
  http://localhost:3000/login

# Signup for demo customer
curl -X POST -H "Host: demo.localhost:3000" \
  -H "Content-Type: application/json" \
  -d '{"fullname":"Test User","email":"test@demo.com","password":"password123"}' \
  http://localhost:3000/signup

# Login for demo customer
curl -X POST -H "Host: demo.localhost:3000" \
  -H "Content-Type: application/json" \
  -d '{"email":"test@demo.com","password":"password123"}' \
  http://localhost:3000/login
```

#### Test 4: ตรวจสอบ get expired day
```bash
# Get expired day for localhost (death customer)
curl http://localhost:3000/getexpiredday

# Get expired day for demo customer
curl -H "Host: demo.localhost:3000" http://localhost:3000/getexpiredday

# Get expired day for test customer
curl -H "Host: test.localhost:3000" http://localhost:3000/getexpiredday
```

#### Test 5: ตรวจสอบ redeem angpao
```bash
# Redeem angpao for localhost (death customer)
curl -X POST -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_TOKEN_HERE" \
  -d '{"link":"https://gift.truemoney.com/campaign/?v=YOUR_CAMPAIGN_ID"}' \
  http://localhost:3000/redeem-angpao

# Redeem angpao for demo customer
curl -X POST -H "Host: demo.localhost:3000" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_TOKEN_HERE" \
  -d '{"link":"https://gift.truemoney.com/campaign/?v=YOUR_CAMPAIGN_ID"}' \
  http://localhost:3000/redeem-angpao
```

## ข้อมูลตัวอย่าง

### Customer 1 (localhost, demo.localhost)
- customer_id: '1'
- website_name: 'death' (localhost), 'demo' (demo.localhost)
- มีข้อมูล: categories, products, users, config, theme_settings

### Customer 2 (test.localhost)  
- customer_id: '2'
- website_name: 'test'
- ข้อมูลว่าง (สำหรับทดสอบ isolation)

## การตรวจสอบ

### 1. ตรวจสอบ Data Isolation
- ลูกค้าแต่ละคนเห็นเฉพาะข้อมูลของตัวเอง
- ไม่สามารถเข้าถึงข้อมูลของลูกค้าอื่น

### 2. ตรวจสอบ Authentication
- Token ต้องมี customer_id ที่ตรงกับ subdomain
- ไม่สามารถใช้ token ระหว่าง subdomain ได้

### 3. ตรวจสอบ Error Handling
- Subdomain ที่ไม่มีใน auth_sites ต้อง return 404
- Request ที่ไม่มี customer context ต้อง return 400

## Production Deployment

### 1. DNS Configuration
ตั้งค่า wildcard DNS:
```
*.yourdomain.com -> your-server-ip
```

### 2. Server Configuration
- เปลี่ยน domain ใน middleware
- ตั้งค่า SSL certificate สำหรับ wildcard domain
- ตั้งค่า reverse proxy (nginx/apache) ถ้าจำเป็น

### 3. Database
- เพิ่มข้อมูลลูกค้าใหม่ในตาราง `auth_sites`
- ตั้งค่า customer_id ให้ unique

## Troubleshooting

### 1. Subdomain ไม่ถูก detect
- ตรวจสอบ Host header
- ตรวจสอบ middleware configuration
- ตรวจสอบ DNS settings

### 2. Customer not found
- ตรวจสอบข้อมูลในตาราง `auth_sites`
- ตรวจสอบ website_name ตรงกับ subdomain

### 3. Data mixing
- ตรวจสอบ customer_id ในทุก query
- ตรวจสอบ JWT token มี customer_id
- ตรวจสอบ middleware ทำงานถูกต้อง
