# ระบบ Role Permissions - คู่มือการใช้งาน

## ภาพรวม
ระบบนี้ใช้ตาราง `roles` และ `users` เพื่อจัดการสิทธิ์การเข้าถึงของผู้ใช้ โดยเชื่อมโยง `users.role` กับ `roles.rank_name`

## ตาราง Roles ที่มีอยู่
1. **member** - สมาชิกทั่วไป (ไม่มีสิทธิ์พิเศษ)
2. **moderator** - ผู้ดูแล (สามารถจัดการ categories, products, orders, keys, reports)
3. **admin** - ผู้ดูแลระบบ (สิทธิ์ครบถ้วน)
4. **super_admin** - ผู้ดูแลระบบสูงสุด (สิทธิ์ครบถ้วน)
5. **reseller** - ผู้ขายต่อ (สามารถเข้าถึงราคา reseller)

## Permissions ที่มี
- `can_edit_categories` - แก้ไขหมวดหมู่
- `can_edit_products` - แก้ไขสินค้า
- `can_edit_users` - แก้ไขผู้ใช้
- `can_edit_orders` - แก้ไขคำสั่งซื้อ
- `can_manage_keys` - จัดการ license keys
- `can_view_reports` - ดูรายงาน
- `can_manage_promotions` - จัดการโปรโมชั่น
- `can_manage_settings` - จัดการการตั้งค่า
- `can_access_reseller_price` - เข้าถึงราคา reseller

## API Endpoints

### 1. ตรวจสอบสิทธิ์ของผู้ใช้
```
GET /myrole
Authorization: Bearer <token>
```

**Response:**
```json
{
  "success": true,
  "message": "User role permissions retrieved successfully",
  "user": {
    "id": 1,
    "fullname": "John Doe",
    "email": "john@example.com",
    "role": "admin"
  },
  "permissions": {
    "can_edit_categories": true,
    "can_edit_products": true,
    "can_edit_users": true,
    "can_edit_orders": true,
    "can_manage_keys": true,
    "can_view_reports": true,
    "can_manage_promotions": true,
    "can_manage_settings": true,
    "can_access_reseller_price": true
  },
  "role_info": {
    "id": 3,
    "rank_name": "admin",
    "description": "Role: admin with specific permissions"
  }
}
```

### 2. ดูรายการ Roles ทั้งหมด (Admin only)
```
GET /roles
Authorization: Bearer <admin_token>
```

### 3. เปลี่ยน Role ของผู้ใช้ (Admin only)
```
PUT /users/:userId/role
Authorization: Bearer <admin_token>
Content-Type: application/json

{
  "role": "moderator"
}
```

### 4. ตัวอย่าง Protected Endpoint
```
GET /admin/dashboard
Authorization: Bearer <token_with_can_view_reports_permission>
```

## การใช้งาน Middleware

### ตรวจสอบสิทธิ์เดียว
```javascript
app.get('/protected-route', authenticateToken, requirePermission('can_edit_products'), (req, res) => {
  // เฉพาะผู้ใช้ที่มีสิทธิ์ can_edit_products เท่านั้น
});
```

### ตรวจสอบสิทธิ์หลายอย่าง (ต้องมีอย่างน้อย 1 อย่าง)
```javascript
app.get('/protected-route', authenticateToken, requireAnyPermission(['can_edit_products', 'can_edit_categories']), (req, res) => {
  // ผู้ใช้ที่มีสิทธิ์ can_edit_products หรือ can_edit_categories
});
```

## ตัวอย่างการทดสอบ

### 1. สร้างผู้ใช้ใหม่
```bash
curl -X POST http://localhost:3000/signup \
  -H "Content-Type: application/json" \
  -d '{
    "fullname": "Test User",
    "email": "test@example.com",
    "password": "password123"
  }'
```

### 2. เข้าสู่ระบบ
```bash
curl -X POST http://localhost:3000/login \
  -H "Content-Type: application/json" \
  -d '{
    "email": "test@example.com",
    "password": "password123"
  }'
```

### 3. ตรวจสอบสิทธิ์
```bash
curl -X GET http://localhost:3000/myrole \
  -H "Authorization: Bearer <token_from_login>"
```

### 4. เปลี่ยน Role (ต้องใช้ Admin token)
```bash
curl -X PUT http://localhost:3000/users/1/role \
  -H "Authorization: Bearer <admin_token>" \
  -H "Content-Type: application/json" \
  -d '{
    "role": "moderator"
  }'
```

## หมายเหตุ
- ผู้ใช้ที่ไม่มี role ในตาราง `roles` จะได้รับสิทธิ์ member (ไม่มีสิทธิ์พิเศษ)
- ระบบจะตรวจสอบสิทธิ์จากตาราง `roles` โดยใช้ `rank_name` เป็น key
- Middleware `requirePermission` และ `requireAnyPermission` สามารถใช้ร่วมกับ `authenticateToken` ได้
