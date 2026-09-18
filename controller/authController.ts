import { Request, Response } from "express";
import AuthModel from '../model/authModel';
import { rotateImage } from "../util/helper";
import moment from "moment";
import { prisma } from "../prisma/client";
import { paramStr } from "../util/paramStr";
const sso = prisma;
//import { customAlphabet } from 'nanoid'

const jwt = require('jsonwebtoken');
const { customAlphabet } = require("nanoid");
const nanoid = customAlphabet("1234567890abcdefghijklmnopqrstuvwzyx", 8);
const pin = customAlphabet("1234567890", 4);
import { hashPassword, verifyPassword } from "../util/password";
const path = require('path');
const fs = require("fs");
const sms = require("../config/sms");
const pwdgen = customAlphabet("1234567890abcdefghijklmnopqrstuvwzyx", 6);
const Auth = new AuthModel();
export default class AuthController {

  async authenticateWithCredential(req: Request, res: Response) {
    try {
      let { username, password }: { username: string, password: string } = req.body;
      if (!username) throw new Error('No username provided!');
      if (!password) throw new Error('No password provided!');
      // Trim only — case is already handled below without normalizing here.
      // Normalizing case on this end (e.g. .toLowerCase()) would be
      // redundant at best, since sso_user.username/tag uses the
      // utf8mb4_unicode_ci collation, which makes MySQL's own
      // `=` comparison case-insensitive already; it'd also risk masking a
      // real mismatch if that collation ever changes. Trimming stray
      // whitespace (a common copy/paste artifact) is the one thing actually
      // worth normalizing here, since collation doesn't cover that.
      username = username.trim();

      const userByName: any = await sso.user.findFirst({ where: { username, status: true }, include: { group: { select: { title: true } } } });
      const isUser: any = userByName && verifyPassword(userByName.password, password) ? userByName : null;

      if (isUser) {
        let { id, tag, groupId, group: { title: groupName } } = isUser;
        let user: any = {};
        if (groupId == 4) { // Support
          const data = await sso.support.findUnique({ where: { supportNo: Number(tag) } });
          if (data) user = { tag, fname: data?.fname, mname: data?.mname, lname: data?.lname, mail: data?.email, descriptor: "IT Support", department: "System Support", group_id: groupId, group_name: groupName }

        } else if (groupId == 2) { // Staff
          const data = await sso.staff.findUnique({ where: { staffNo: tag }, include: { promotion: { select: { job: true } }, job: true, unit: true }, });
          if (data) user = { tag, fname: data?.fname, mname: data?.mname, lname: data?.lname, mail: data?.email, descriptor: data?.job?.title, department: data?.unit?.title, group_id: groupId, group_name: groupName }

        } else { // Student
          const data = await sso.student.findUnique({ where: { id: tag }, include: { program: { select: { longName: true } } } });
          if (data) user = { tag, fname: data?.fname, mname: data?.mname, lname: data?.lname, mail: data?.email, descriptor: data?.program?.longName, department: "", group_id: groupId, group_name: groupName }
        }

        
        // SSO Photo
        const photo = `${process.env.UMS_DOMAIN}/api/auth/photos/?tag=${encodeURIComponent(tag)}`;
        // Roles & Privileges
        const roles: any = await sso.userRole.findMany({ 
          where: { userId: id }, 
          include: { 
            appRole: { 
              select: { 
                title: true, 
                appModule: { 
                  select: { 
                    tag: true,
                    title: true,
                    app: { select: { tag: true, title: true } }
                  } 
                } 
              } 
            } 
          }
        });

        let userdata: any = { user, roles: [], photo }
        
        // Normal Roles
        if (roles?.length) userdata.roles = [
          ...userdata.roles, 
          ...(roles.map((r:any) => {
              return ({
                 userId: r.userId,
                 role: `${r.appRole?.appModule?.tag}::${r.appRole?.title?.toLowerCase()}`,
                 module: r.appRole?.appModule?.tag,
                 app:  r.appRole?.appModule?.app?.tag
              })
          }))
        ]

        // Generate Session Token &
        const token = jwt.sign(userdata || {}, process.env.SECRET, { expiresIn: 60 * 60 });
        // Log Login Response
        await sso.log.create({ data: { action: `${groupName?.toUpperCase()}_LOGIN_SUCCESS`, user: tag, meta: userdata, ...groupId == 1 && ({ student: tag }) } })
        // Send Response to Client
        // console.log({ success: true, data: userdata, token });
        return res.status(200).json({ success: true, data: userdata, token });

      } else {
        return res.status(401).json({ success: false, message: "Invalid Credentials!" });
      }

    } catch (error: any) {
      console.log(error)
      return res.status(401).json({ success: false, message: error.message });
    }
  }

  async authenticateWithGoogle(req: Request, res: Response) {

    const { providerId, email }: { providerId: string, email: string } = req.body;
    try {
      if (!email) throw new Error('No identity Email provided!');
      // Get University User Record and Category
      var user = await Auth.fetchUserByVerb(email);
      if (user) {
        // Locate Single-Sign-On Record
        const isUser = await Auth.fetchSSOUser(user.tag);
        if (isUser) {
          const photo = `https://cdn.ucc.edu.gh/photos/?tag=${encodeURIComponent(user?.tag)}`;
          const { uid, group_id: gid } = isUser;
          let roles = uid ? await Auth.fetchRoles(uid) : []; // All App Roles
          let evsRoles = await Auth.fetchEvsRoles(user.tag); // Only Electa Roles
          // Construct UserData
          const userdata: any = {
            user: { tag: user.tag, fname: user.fname, mname: user.mname, lname: user.lname, mail: user.username, descriptor: user.descriptor, department: user.unitname, group_id: gid, group_name: user.group_name },
            roles: [...roles, ...evsRoles],
            photo
          }
          // Generate Session Token &
          const token = jwt.sign(userdata || {}, process.env.SECRET, { expiresIn: 60 * 60 });
          // Send Response to Client
          res.status(200).json({ success: true, data: userdata, token });


        } else {
          const pwd = nanoid();
          const photo = `https://cdn.ucc.edu.gh/photos/?tag=${encodeURIComponent(user?.tag)}`;
          // Create Single-Sign-On Account or Record
          const ins = await Auth.insertSSOUser({
            username: email,
            password: hashPassword(pwd),
            group_id: user.gid,
            tag: user.tag,
          });
          if (ins?.insertId) {
            const uid = ins.insertId;
            let evsRoles = await Auth.fetchEvsRoles(user.tag); // EVS Roles
            // Construct UserData
            const userdata: any = {
              user: { tag: user.tag, fname: user.fname, mname: user.mname, lname: user.lname, mail: user.username, descriptor: user.descriptor, department: user.unitname, group_id: user.gid, group_name: user.group_name },
              roles: [...evsRoles],
              photo
            }
            // Generate Session Token & 
            const token = jwt.sign(userdata || {}, process.env.SECRET, { expiresIn: 60 * 60 });
            // Send Response to Client
            res.status(200).json({ success: true, data: userdata, token });

          } else {
            res.status(500).json({
              success: false,
              message: "Account not Staged!",
            });
          }
        }
      } else {
        res.status(401).json({
          success: false,
          message: "Invalid email account!",
        });
      }
    } catch (e: any) {
      console.log(e);
      res.status(401).json({ success: false, message: e.message });
    }
  }


  // "Switch Account" / impersonation — inherit another user's (or
  // applicant's) session without their password. Structurally mirrors
  // authenticateWithCredential's isUser/isApplicant branches so the issued
  // token has the exact same shape (role tags, photo URL convention) a real
  // login would produce; the only difference is the lookup is by tag alone,
  // with no password check, since this is only reachable by an already-
  // authenticated caller (see the verifyToken guard on this route).
  async authenticateWithKey(req: Request & any, res: Response) {
    try {
      const { tag: username }: { tag: string } = req.body;
      if (!username) throw new Error('No username provided!');

      const isUser: any = await sso.user.findFirst({ where: { tag: username }, include: { group: { select: { title: true } } } });

      if (isUser) {
        let { id, tag, groupId, group: { title: groupName } } = isUser;
        let user: any = {};
        if (groupId == 4) { // Support
          const data = await sso.support.findUnique({ where: { supportNo: Number(tag) } });
          if (data) user = { tag, fname: data?.fname, mname: data?.mname, lname: data?.lname, mail: data?.email, descriptor: "IT Support", department: "System Support", group_id: groupId, group_name: groupName }

        } else if (groupId == 2) { // Staff
          const data = await sso.staff.findUnique({ where: { staffNo: tag }, include: { promotion: { select: { job: true } }, job: true, unit: true }, });
          if (data) user = { tag, fname: data?.fname, mname: data?.mname, lname: data?.lname, mail: data?.email, descriptor: data?.job?.title, department: data?.unit?.title, group_id: groupId, group_name: groupName }

        } else { // Student
          const data = await sso.student.findUnique({ where: { id: tag }, include: { program: { select: { longName: true } } } });
          if (data) user = { tag, fname: data?.fname, mname: data?.mname, lname: data?.lname, mail: data?.email, descriptor: data?.program?.longName, department: "", group_id: groupId, group_name: groupName }
        }

        const photo = `${process.env.UMS_DOMAIN}/api/auth/photos/?tag=${encodeURIComponent(tag)}`;
        const roles: any = await sso.userRole.findMany({
          where: { userId: id },
          include: {
            appRole: {
              select: {
                title: true,
                appModule: {
                  select: {
                    tag: true,
                    title: true,
                    app: { select: { tag: true, title: true } }
                  }
                }
              }
            }
          }
        });

        let userdata: any = { user, roles: [], photo }
        if (roles?.length) userdata.roles = [
          ...userdata.roles,
          ...(roles.map((r: any) => ({
            userId: r.userId,
            role: `${r.appRole?.appModule?.tag}::${r.appRole?.title?.toLowerCase()}`,
            module: r.appRole?.appModule?.tag,
            app: r.appRole?.appModule?.app?.tag
          })))
        ]

        const token = jwt.sign(userdata || {}, process.env.SECRET, { expiresIn: 60 * 60 });
        await sso.log.create({ data: { action: `SWITCH_USER`, user: req?.userId, meta: { switchedTo: tag, ...userdata } } })
        return res.status(200).json({ success: true, data: userdata, token });

      } else {
        return res.status(401).json({ success: false, message: "Invalid Credentials!" });
      }
    } catch (error: any) {
      console.log(error)
      return res.status(401).json({ success: false, message: error.message });
    }
  }

  /* Account & Password */
  async changePassword(req: Request, res: Response) {
    try {
      const { oldpassword, newpassword, tag } = req.body;
      const userByTag = await sso.user.findFirst({ where: { tag } })
      const isUser = userByTag && verifyPassword(userByTag.password, oldpassword) ? userByTag : null;
      if (isUser) {
        const ups = await sso.user.updateMany({
          where: { tag },
          data: { password: hashPassword(newpassword) }
        })
        // Log Login Response
        await sso.log.create({ data: { action: `USER_PASSWORD_CHANGED`, user: tag, meta: req.body, ...isUser?.groupId == 1 && ({ student: tag }) } })
        // Response  
        res.status(200).json(ups)
      } else {
        res.status(202).json({ message: `Wrong password provided!` })
      }

    } catch (error: any) {
      console.log(error)
      return res.status(500).json({ message: error.message })
    }
  }

  async forgetPassword(req: Request, res: Response) {
    try {
      let { tag, phone } = req.body;
      const password = pwdgen();
      phone = phone.replaceAll("+233", "0").replaceAll(" ", "").replaceAll("-", "").replaceAll("(", "").replaceAll(")", "").split("/")[0].trim();

      const user = await sso.user.findFirst({ where: { OR: [{ tag }, { username: tag }] } });
      if (user) {
        let st;
        if (user?.groupId == 1) {
          st = await sso.student.findFirst({ where: { OR: [{ id: user.tag }, { indexno: user.tag }], phone } });
        } else if (user?.groupId == 2) {
          st = await sso.staff.findFirst({ where: { staffNo: user.tag, phone } });
        }

        if(!st) return res.status(202).json({ message: `No Record found for Phone No!` })
        
        // Return Response
        const ups = await sso.user.updateMany({
          where: { tag: user.tag }, data: { password: hashPassword(password) }
        })
        // Send Password By SMS
        if (st?.phone) await sms(st?.phone, `Hi! Your new credentials is username: ${st?.instituteEmail}, password: ${password}`)
        // Log Login Response
        await sso.log.create({ data: { action: `FORGOT_PASSWORD_CHANGED`, user: tag, meta: req.body, ...user?.groupId == 1 && ({ student: tag }) } })
        // Response  
        res.status(200).json({ success: true, data: ups });
      } else {
        res.status(202).json({ message: `Wrong password provided!` })
      }

    } catch (error: any) {
      console.log(error)
      return res.status(500).json({ message: error.message })
    }
  }

  /* SSO Management */

  /* Send Student Pin */
  async sendStudentPin(req: Request, res: Response) {
    try {
      const tag = paramStr(req.params.tag);
      const user = await sso.user.findFirst({ where: { groupId: 1, status: true, tag } })
      if (user) {
        const st = await sso.student.findUnique({ where: { id: tag } });
        const msg = `Please Access https://portal.akatsico.edu.gh with USERNAME: ${user.username}, PIN: ${user.unlockPin}. Note that you can use 4-digit PIN as PASSWORD`
        let resp;
        if (st && st?.phone) {
          resp = await sms(st?.phone, msg);
        } else {
          resp = { code: 1002 }
        }
        res.status(200).json(resp)

      } else {
        res.status(202).json({ message: `Invalid request!` })
      }

    } catch (error: any) {
      console.log(error)
      return res.status(500).json({ message: error.message })
    }
  }

  /* Send Voter Pins */
  async sendVoterReminder(req: Request, res: Response) {
    try {
      const id = paramStr(req.params.id);
      const en:any = await sso.election.findFirst({ where: { id: Number(id), status: true } });
      if (en) {
        const ev = await sso.elector.findMany({ select: {tag: true }, where: { electionId: Number(id)} });
        let users: any = en?.voterData?.filter((r:any) => !ev.find(m => m.tag?.toLowerCase() == r.tag?.toLowerCase()));
        if (users?.length) {
          const resp: any = await Promise.all(users?.map(async (row: any, i: number) => {
            // if(i == 0){
              const fname = row?.name?.split(' ')[0]?.toLowerCase();
              const msg = `Hi ${fname?.charAt(0)?.toUpperCase() + fname.slice(1)}! ${en?.title?.toLowerCase()?.split(' ').map((word:any) => word?.charAt(0)?.toUpperCase() + word?.slice(1))?.join(' ')} is currently on-going. Please log into https://portal.akatsico.edu.gh to cast vote under the [Elections Portal], Election closes in ${moment(en?.endAt).fromNow() }. Thank you!!`
              if (row?.phone) return await sms(row?.phone, msg);
              // if (row?.phone) return await sms('0277675089', msg);
              //console.log(`${row?.tag} : ${row?.phone} \n\n${msg}`)
              return { code: 1002 }
            // }
          }))
          console.log(resp);
          return res.status(200).json(resp)
        } else {
          return res.status(202).json({ message: `Invalid request!` })
        }
      }
      return res.status(202).json({ message: `Invalid request!` })

    } catch (error: any) {
      console.log(error)
      return res.status(500).json({ message: error.message })
    }
  }

  /* Send Voter Pins */
  async sendVoterPins(req: Request, res: Response) {
    try {
      const id = paramStr(req.params.id);
      const en = await sso.election.findFirst({ where: { id: Number(id), status: true } });
      if (en) {
        const users: any = en?.voterData;
        if (users?.length) {
          const resp: any = await Promise.all(users?.map(async (row: any) => {
            const msg = `Please Access https://portal.akatsico.edu.gh with USERNAME: ${row.username}, PIN: ${row.pin}. Note that you can use 4-digit PIN as PASSWORD`
            if (row?.phone) return await sms(row?.phone, msg);
            return { code: 1002 }
          }))
          return res.status(200).json(resp)
        } else {
          return res.status(202).json({ message: `Invalid request!` })
        }
      }
      return res.status(202).json({ message: `Invalid request!` })

    } catch (error: any) {
      console.log(error)
      return res.status(500).json({ message: error.message })
    }
  }


  /* Send Student Pins */
  async sendStudentPins(req: Request, res: Response) {
    try {
      const users = await sso.user.findMany({ where: { groupId: 1, status: true } })
      if (users?.length) {
        const resp: any = await Promise.all(users?.map(async (row: any) => {
          const st = await sso.student.findUnique({ where: { id: row?.tag } });
          const msg = `Please Access https://portal.akatsico.edu.gh with USERNAME: ${row.username}, PIN: ${row.unlockPin}. Note that you can use 4-digit PIN as PASSWORD`
          if (st && st?.phone) return await sms(st.phone, msg);
          return { code: 1002 }
        }))
        res.status(200).json(resp)
      } else {
        res.status(202).json({ message: `Invalid request!` })
      }
    } catch (error: any) {
      console.log(error)
      return res.status(500).json({ message: error.message })
    }
  }

  /* Reset Student Pins  */
  async resetStudentPins(req: Request, res: Response) {
    try {
      const users = await sso.user.findMany({
        where: { groupId: 1, status: true }
      })
      if (users?.length) {
        const resp: any = await Promise.all(users?.map(async (row: any) => {
          return await sso.user.update({
            where: { id: row?.id },
            data: { unlockPin: pin() }
          })
        }))
        res.status(200).json(resp)
      } else {
        res.status(202).json({ message: `Invalid request!` })
      }
    } catch (error: any) {
      console.log(error)
      return res.status(500).json({ message: error.message })
    }
  }

  /* Reset Student Pins  */
  async resetStudentPin(req: Request, res: Response) {
    try {
      const tag = paramStr(req.params.tag);
      const user = await sso.user.findFirst({ where: { groupId: 1, status: true, tag } })
      if (user) {
        const resp: any = await sso.user.updateMany({
          where: { tag },
          data: { unlockPin: pin() }
        })
        res.status(200).json(resp)
      } else {
        res.status(202).json({ message: `Invalid request!` })
      }

    } catch (error: any) {
      console.log(error)
      return res.status(500).json({ message: error.message })
    }
  }

  /* Photo Management */
  // async fetchPhoto(req: Request,res: Response) {
  //   try {
  //       res.setHeader("Access-Control-Allow-Origin", "*");
  //       let mtag:any = req?.query?.tag;
  //           mtag = mtag.trim().toLowerCase();
  //       const isUser = await sso.user.findFirst({ where: { tag: mtag }}); // Biodata
  //       console.log(mtag,isUser)
  //       if (isUser) {
  //           let { groupId } = isUser, spath;
  //           const tag = mtag.replaceAll("/", "").replaceAll("_", "");
  //           if(groupId == 4)       spath = path.join(__dirname, "/../../public/cdn/photo/support/");
  //           else if(groupId == 3)  spath = path.join(__dirname, "/../../public/cdn/photo/applicant/");
  //           else if(groupId == 2)  spath = path.join(__dirname, "/../../public/cdn/photo/staff/");
  //           else if(groupId == 1)  spath = path.join(__dirname, "/../../public/cdn/photo/student/");
  //           else spath = path.join(__dirname, "/../../public/cdn/");

  //           const file = `${spath}${tag}.jpg`;
  //           const file2 = `${spath}${tag}.jpeg`;
  //           console.log("TEST:  ",file)
  //           try {
  //             if(fs.statSync(file)) return res.status(200).sendFile(file);
  //             else if(fs.statSync(file2)) return res.status(200).sendFile(file2);
  //             else return res.status(200).sendFile(`${spath}/none.png`);
  //           } catch (e) {
  //             return res.status(200).sendFile(path.join(__dirname, "/../../public/cdn/")+`/none.png`);
  //           }
  //       } else {
  //           res.status(200).sendFile(path.join(__dirname, "/../../public/cdn", "none.png"));
  //       }
  //   } catch(err) {
  //       console.log(err)
  //       res.status(200).sendFile(path.join(__dirname, "/../../public/cdn", "none.png"));
  //   }
  // }

  async fetchAmsApk(req: Request, res: Response) {
    try {
      res.setHeader("Access-Control-Allow-Origin", "*");
      res.setHeader("Access-Control-Allow-Origin", "*");
      res.setHeader("Cross-Origin-Opener-Policy", "cross-origin");
      res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
      res.header(
        "Access-Control-Allow-Headers",
        "x-access-token, Origin, Content-Type, Accept"
      );

      let type: any = req?.query?.type;
      if (type && fs.existsSync(path.join(__dirname, `/../../public/cdn/mobile/ios/aucb.ipa`))) {
        res.setHeader('Content-Type', 'binary/octet-stream');
        return res.status(200).sendFile(path.join(__dirname, `/../../public/cdn/mobile/ios/aucb.ipa`));
      } else {
        res.setHeader('Content-Type', 'application/vnd.android.package-archive');
        return res.status(200).sendFile(path.join(__dirname, `/../../public/cdn/mobile/android/aucb.apk`));
      }
    } catch (err) {
      console.log(err)
      res.setHeader('Content-Type', 'application/vnd.android.package-archive');
      return res.status(200).sendFile(path.join(__dirname, `/../../public/cdn/mobile/android/aucb.apk`));
    }
  }

  async fetchEvsPhoto(req: Request, res: Response) {
    try {
      res.setHeader("Access-Control-Allow-Origin", "*");
      res.setHeader("Access-Control-Allow-Origin", "*");
      res.setHeader("Cross-Origin-Opener-Policy", "cross-origin");
      res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
      res.header(
        "Access-Control-Allow-Headers",
        "x-access-token, Origin, Content-Type, Accept"
      );
      res.setHeader('Content-Type', 'image/jpeg');
      let eid: any = req?.query?.eid;
      let mtag: any = req?.query?.tag;
      mtag = mtag?.trim()?.toLowerCase();
      const tag = mtag?.replaceAll("/", "")?.replaceAll("_", "");

      if (!mtag && fs.existsSync(path.join(__dirname, `/../../public/cdn/photo/evs`, `${eid}.png`))) return res.status(200).sendFile(path.join(__dirname, `/../../public/cdn/photo/evs`, `${eid}.png`));
      else if (fs.existsSync(path.join(__dirname, `/../../public/cdn/photo/evs/${eid}`, `${tag}.jpg`))) return res.status(200).sendFile(path.join(__dirname, `/../../public/cdn/photo/evs/${eid}`, `${tag}.jpg`));
      else return res.status(200).sendFile(path.join(__dirname, "/../../public/cdn/") + `/none.png`);
    } catch (err) {
      console.log(err);
      res.setHeader('Content-Type', 'image/jpeg');
      return res.status(200).sendFile(path.join(__dirname, "/../../public/cdn", "none.png"));
    }
  }

  async fetchPhoto(req: Request, res: Response) {
    try {
      res.setHeader("Access-Control-Allow-Origin", "*");
      res.setHeader("Access-Control-Allow-Origin", "*");
      res.setHeader("Cross-Origin-Opener-Policy", "cross-origin");
      res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
      res.header(
        "Access-Control-Allow-Headers",
        "x-access-token, Origin, Content-Type, Accept"
      );
      res.setHeader('Content-Type', 'image/jpeg');
      let mtag: any = req?.query?.tag;
      mtag = mtag.trim().toLowerCase();
      const tag = mtag.replaceAll("/", "").replaceAll("_", "");
      if (fs.existsSync(path.join(__dirname, "/../../public/cdn/photo/staff/", `${tag}.jpg`))) return res.status(200).sendFile(path.join(__dirname, "/../../public/cdn/photo/staff/", `${tag}.jpg`));
      else if (fs.existsSync(path.join(__dirname, "/../../public/cdn/photo/staff/", `${tag}.jpeg`))) return res.status(200).sendFile(path.join(__dirname, "/../../public/cdn/photo/staff/", `${tag}.jpeg`));
      else if (fs.existsSync(path.join(__dirname, "/../../public/cdn/photo/student/", `${tag}.jpg`))) return res.status(200).sendFile(path.join(__dirname, "/../../public/cdn/photo/student/", `${tag}.jpg`));
      else if (fs.existsSync(path.join(__dirname, "/../../public/cdn/photo/student/", `${tag}.jpeg`))) return res.status(200).sendFile(path.join(__dirname, "/../../public/cdn/photo/student/", `${tag}.jpeg`));
      else if (fs.existsSync(path.join(__dirname, "/../../public/cdn/photo/support/", `${tag}.jpg`))) return res.status(200).sendFile(path.join(__dirname, "/../../public/cdn/photo/support/", `${tag}.jpg`));
      else if (fs.existsSync(path.join(__dirname, "/../../public/cdn/photo/support/", `${tag}.jpeg`))) return res.status(200).sendFile(path.join(__dirname, "/../../public/cdn/photo/support/", `${tag}.jpeg`));
      else res.status(200).sendFile(path.join(__dirname, "/../../public/cdn/") + `/none.jpg`);
    } catch (err) {
      console.log(err)
      res.setHeader('Content-Type', 'image/jpeg');
      return res.status(200).sendFile(path.join(__dirname, "/../../public/cdn", "none.jpg"));
    }
  }

  async postPhoto(req: Request, res: Response) {

    if (!req.files || Object.keys(req.files).length === 0) {
      return res.status(400).send('No files were uploaded.');
    }
    const photo: any = req?.files?.photo;
    const { tag } = req.body;
    const isUser: any = await sso.user.findFirst({ where: { tag } });

    if (!isUser) {
      const stphoto = `${req.protocol}://${req.get("host")}/api/auth/photos/?tag=${tag?.toString()?.toLowerCase()}&cache=${Math.random() * 1000}`;
      return res.status(200).json({ success: true, data: stphoto });
    }

    let { groupId } = isUser;
    var mpath;
    switch (groupId) {
      case 1: mpath = "student"; break;
      case 2: mpath = "staff"; break;
      case 4: mpath = "support"; break;
      default: mpath = "student"; break;
    }
    const dest = path.join(__dirname, "/../../public/cdn/photo/" + mpath, (tag && tag?.toString()?.replaceAll("/", "")?.trim()?.toLowerCase()) + ".jpg");
    photo.mv(dest, function (err: any) {
      if (err) return res.status(500).send(err);
      const stphoto = `${req.protocol}://${req.get("host")}/api/auth/photos/?tag=${tag.toString().toLowerCase()}&cache=${Math.random() * 1000}`;
      return res.status(200).json({ success: true, data: stphoto });
    })
  }

  //   async sendPhotos(req: Request,res: Response) {
  //     var { gid } = req.body;
  //     var spath = path.join(__dirname,"/../../public/cdn/photo/"), mpath;
  //     if (req.files && req.files.photos.length > 0) {
  //       for (var file of req.files.photos) {
  //         switch (parseInt(gid)) {
  //           case 1:
  //             mpath = `${spath}/student/`;
  //             break;
  //           case 2:
  //             mpath = `${spath}/staff/`;
  //             break;
  //           case 3:
  //             mpath = `${spath}/nss/`;
  //             break;
  //           case 4:
  //             mpath = `${spath}/applicant/`;
  //             break;
  //           case 5:
  //             mpath = `${spath}/alumni/`;
  //             break;
  //           case 6:
  //             mpath = `${spath}/code/`;
  //             break;
  //         }
  //         let tag = file.name.toString().split(".")[0].replaceAll("/", "").trim().toLowerCase();
  //             tag = `${mpath}${tag}.jpg`;
  //         file.mv(tag, (err) => {
  //           if (!err) count = count + 1;
  //         });
  //       }
  //       res.status(200).json({ success: true, data: null });
  //     }
  //   }

  async rotatePhoto(req: Request, res: Response) {
    let { studentId: tag } = req.body;
    var spath = path.join(__dirname, "/../../public/cdn/photo/");
    const isUser: any = await sso.user.findFirst({ where: { tag } });
    let { groupId } = isUser;
    switch (parseInt(groupId)) {
      case 1: spath = `${spath}/student/`; break;
      case 2: spath = `${spath}/staff/`; break;
      case 4: spath = `${spath}/support/`; break;
    }
    tag = tag.toString().replaceAll("/", "").trim().toLowerCase();
    const file = `${spath}${tag}.jpg`;
    const file2 = `${spath}${tag}.jpeg`;
    var stats = fs.existsSync(file);
    var stats2 = fs.existsSync(file2);
    if (stats) {
      await rotateImage(file);
      const stphoto = `${req.protocol}://${req.get("host")}/api/photos/?tag=${tag.toString().toLowerCase()}&cache=${Math.random() * 1000}`;
      res.status(200).json({ success: true, data: stphoto });
    } else if (stats2) {
      await rotateImage(file2);
      const stphoto = `${req.protocol}://${req.get("host")}/api/photos/?tag=${tag.toString().toLowerCase()}&cache=${Math.random() * 1000}`;
      res.status(200).json({ success: true, data: stphoto });
    } else {
      res.status(200).json({ success: false, data: null, msg: "Photo Not Found!" });
    }
  }

  async removePhoto(req: Request, res: Response) {
    let tag: any = paramStr(req.params.id);
    const isUser: any = await sso.user.findFirst({ where: { tag } });
    let { groupId } = isUser;
    var spath = path.join(__dirname, "/../../public/cdn/photo");
    switch (parseInt(groupId)) {
      case 1: spath = `${spath}/student/`; break;
      case 2: spath = `${spath}/staff/`; break;
      case 4: spath = `${spath}/support/`; break;
    }
    tag = tag.toString().replaceAll("/", "").replaceAll("_", "").trim().toLowerCase();
    const file = `${spath}${tag}.jpg`;
    const file2 = `${spath}${tag}.jpeg`;
    if (fs.existsSync(file)) {
      fs.unlinkSync(file);
      const stphoto = `${req.protocol}://${req.get("host")}/api/photos/?tag=${tag.toString().toLowerCase()}&cache=${Math.random() * 1000}`;
      res.status(200).json({ success: true, data: stphoto });
    } else if (fs.existsSync(file2)) {
      fs.unlinkSync(file2);
      const stphoto = `${req.protocol}://${req.get("host")}/api/photos/?tag=${tag.toString().toLowerCase()}&cache=${Math.random() * 1000}`;
      res.status(200).json({ success: true, data: stphoto });
    }

    else {
      res.status(200).json({ success: false, data: null, msg: "Photo Not Found!" });
    }
  }



}
